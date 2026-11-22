"""Translate v1 turns to the pinned upstream deterministic teaching controller."""

from collections import OrderedDict
from hashlib import sha256
from time import monotonic

from app.agent.coaching import CommandConflict
from app.agent.coaching_intents import coaching_intent
from app.schemas.models import ChatRequest

from .contracts import Fault


TURN_REPLAY_SECONDS = 2 * 60 * 60
MAX_TURN_RECEIPTS = 1024


class CoachingTurns:
    def __init__(self, agent):
        self.agent = agent
        self.receipts = OrderedDict()

    def session(self, owner, session_id):
        try:
            session = self.agent.sessions.get(session_id)
        except KeyError:
            raise Fault(404, "会话不存在。") from None
        if session.user_id != owner:
            raise Fault(404, "会话不存在。")
        return session

    def send(self, owner, body):
        # Use the original lock and event ID so concurrent callers cannot advance the same step twice.
        with self.agent.sessions.lock:
            key = (owner, body.requestId)
            digest = sha256(body.model_dump_json().encode()).digest()
            now = monotonic()
            while self.receipts and next(iter(self.receipts.values()))[0] <= now:
                self.receipts.popitem(last=False)
            if previous := self.receipts.get(key):
                if previous[1] != digest:
                    raise Fault(409, "同一请求 ID 已用于其他内容。")
                return previous[2]

            session = self.session(owner, body.sessionId) if body.sessionId else self.agent.sessions.create(owner)
            if session.makeup_plan and session.locale != body.locale:
                raise Fault(409, "请使用当前课程语言，或开启新会话。")
            session.locale = body.locale
            result = self._respond(session, body)
            self.receipts[key] = (now + TURN_REPLAY_SECONDS, digest, result)
            if len(self.receipts) > MAX_TURN_RECEIPTS:
                self.receipts.popitem(last=False)
            return result

    def _respond(self, session, body):
        zh = body.locale == "zh-CN"
        text = body.message.text
        intent = coaching_intent(text)
        if intent == "save":
            raise Fault(403, "请先在偏好页审阅并确认保存。" if zh else "Review and confirm the preference in Memory.")
        try:
            result = self.agent.coaching.handle(session, ChatRequest(
                user_id=session.user_id, session_id=session.session_id,
                message=text, locale=body.locale, event_id=body.requestId,
            ))
        except CommandConflict as exc:
            status = 503 if exc.code == "COURSE_UNAVAILABLE" else 409
            raise Fault(status, str(exc)) from None
        except ValueError:
            raise Fault(503, "当前没有可用课程。" if zh else "The requested lesson is unavailable.") from None

        if result is None or (intent == "chat" and result.get("state_unchanged")):
            # Upstream reply_text delegates ordinary chat to a simulated model. Keep that path unexposed.
            raise Fault(503, "目前支持自然妆教学。可输入‘我想学日常自然妆’或使用课程控制。" if zh else
                        "Natural makeup coaching is available. Start a daily makeup lesson or use its controls.")
        if summary := result.get("summary"):
            steps = summary["completed_steps"]
            if zh:
                confirmed = "你确认完成了" + "、".join(steps) + "。" if steps else "本次没有确认完成的步骤。"
                reply = "本次教学已结束。" + confirmed
            else:
                confirmed = "You confirmed: " + ", ".join(steps) + "." if steps else "No steps were confirmed complete."
                reply = "The lesson has ended. " + confirmed
        else:
            reply = self.agent.coaching.reply_text(session, result, intent, text)

        plan = session.makeup_plan
        stage = {"draft": "conversation", "active": "guidance", "completed": "completed"}[plan.status]
        if plan.workflow == "PAUSED":
            stage = "paused"
        step_id = plan.steps[plan.active_index].id if stage in ("guidance", "paused") else None
        if plan.knowledge_status == "draft":
            label = "待审核原创课程。" if zh else "Original draft curriculum awaiting expert review. "
            if not reply.startswith(label):
                reply = label + reply
        return {
            "session": {"id": session.session_id, "locale": session.locale,
                        "workflow": {"stage": stage, "revision": plan.revision or None, "stepId": step_id}},
            "content": {"speech": reply, "display": {"text": reply}},
        }
