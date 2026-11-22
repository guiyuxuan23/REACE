"""Map V2 preference proposals to V1's signed preview and SQLite write transaction."""

from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import re
from time import monotonic

from .contracts import Fault, PreferenceCorrection


PROPOSAL_SECONDS = 300
MAX_PENDING = 100
MAX_RECEIPTS = 512
MAX_RECORDS = 256
CONTEXT = re.compile(r"trace-v2:(finish|fragrance|tools):([1-9][0-9]{0,9})")


@dataclass(frozen=True)
class PendingPreference:
    expires: float
    preview: dict
    response: dict
    expected_stamp: str | None
    record_version: int


def as_record(episode):
    match = CONTEXT.fullmatch(episode["context"])
    if match:
        return {"id": episode["memory_id"], "version": int(match[2]),
                "preference": {"key": match[1], "value": episode["feedback"]}}
    return None


class Preferences:
    def __init__(self, agent):
        self.agent = agent
        self.pending = {}
        self.receipts = OrderedDict()
        self.deleted = OrderedDict()

    def profile(self, owner):
        episodes = self.agent.memory.profile(owner)["episodes"]
        return {"records": [record for episode in episodes if (record := as_record(episode))]}

    def _episode(self, owner, memory_id):
        for episode in self.agent.memory.profile(owner)["episodes"]:
            if episode["memory_id"] == memory_id and (record := as_record(episode)):
                return episode, record
        raise Fault(404, "偏好不存在。")

    def propose(self, owner, body):
        with self.agent.sessions.lock:
            now = monotonic()
            self.pending = {key: item for key, item in self.pending.items() if item.expires > now}
            if len(self.pending) >= MAX_PENDING:
                raise Fault(503, "尚待确认的候选过多，请稍后再试。", retryable=True)
            memory_id = None
            expected_stamp = None
            version = 1
            if isinstance(body, PreferenceCorrection):
                memory_id = body.memoryId
                episode, record = self._episode(owner, memory_id)
                if record["version"] != body.expectedVersion or body.expectedVersion == 2_147_483_647:
                    raise Fault(409, "偏好版本已变更，请重新读取。")
                version = record["version"] + 1
                expected_stamp = episode["version"]
            preference = body.preference
            candidate = {"feedback": preference.value, "context": f"trace-v2:{preference.key}:{version}"}
            if preference.key == "finish":
                candidate["preferred_finish"] = [preference.value]
            if preference.key == "fragrance":
                candidate["domain_preferences"] = {"fragrance": [preference.value]}
            preview = self.agent.memory.prepare(owner, candidate, memory_id=memory_id, expected_version=expected_stamp)
            proposal_id = preview["candidate_id"]
            response = {"id": proposal_id, "version": 1, "operation": body.operation, "memoryId": memory_id,
                        "preference": preference.model_dump(),
                        "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=PROPOSAL_SECONDS)).isoformat()}
            self.pending[owner, proposal_id] = PendingPreference(
                now + PROPOSAL_SECONDS, preview, response, expected_stamp, version,
            )
            return response

    def confirm(self, owner, body):
        if not body.confirmed:
            raise Fault(403, "保存偏好需要明确确认。")
        key = (owner, body.proposalId)
        with self.agent.sessions.lock:
            record = self.receipts.get(key)
            if record is not None:
                if body.expectedVersion != 1 or record is REVOKED:
                    raise Fault(409, "偏好候选已变更或撤销，请重新审阅。")
                return record
            proposal = self.pending.get(key)
            if proposal is None:
                raise Fault(404, "偏好候选不存在。")
            if body.expectedVersion != 1 or monotonic() >= proposal.expires:
                raise Fault(409, "偏好候选版本不符或已过期，请重新审阅。")
            memory_id = proposal.response["memoryId"]
            if memory_id is None and len(self.profile(owner)["records"]) >= MAX_RECORDS:
                raise Fault(409, "已达到偏好数量上限。删除一条偏好后可以继续保存。")
            try:
                saved = self.agent.memory.save(
                    owner, proposal.preview["candidate"], True, candidate_id=body.proposalId,
                    candidate_version=proposal.preview["candidate_version"], memory_id=memory_id,
                    expected_version=proposal.expected_stamp,
                )
            except (KeyError, ValueError):
                raise Fault(409, "目标偏好已变更或删除，请重新读取。") from None
            self.pending.pop(key)
            record_id = saved["memory_id"]
            self._revoke_receipts(owner, record_id)
            record = {"id": record_id, "version": proposal.record_version, "preference": proposal.response["preference"]}
            self._remember(self.receipts, key, record)
            return record

    def delete(self, owner, memory_id):
        with self.agent.sessions.lock:
            key = (owner, memory_id)
            if key not in self.deleted:
                self._episode(owner, memory_id)
                self.agent.delete_memory(owner, memory_id, True)
                self._revoke_receipts(owner, memory_id)
                self._remember(self.deleted, key, True)
            return {"id": memory_id, "status": "deleted"}

    def _revoke_receipts(self, owner, memory_id):
        for key, record in self.receipts.items():
            if key[0] == owner and record is not REVOKED and record["id"] == memory_id:
                self.receipts[key] = REVOKED

    @staticmethod
    def _remember(records, key, value):
        records[key] = value
        if len(records) > MAX_RECEIPTS:
            records.popitem(last=False)


REVOKED = object()
