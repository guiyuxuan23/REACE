"""Input boundaries for the existing TRACE v1 JSON contract."""

from datetime import datetime
import re
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter, ValidationError


ID_PATTERN = r"[A-Za-z0-9_-]{1,80}"
Identifier = Annotated[str, Field(pattern=f"^{ID_PATTERN}$")]
Version = Annotated[int, Field(ge=1, le=2_147_483_647)]
Category = Literal["face", "lips", "tools"]


class Fault(Exception):
    def __init__(self, status, message, *, retryable=False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Text(Input):
    kind: Literal["text"]
    text: Annotated[str, Field(min_length=1, max_length=2000, pattern=r"\S")]


class AgentRequest(Input):
    requestId: Identifier
    sessionId: Identifier | None = None
    locale: Literal["zh-CN", "en"]
    message: Text


class Consent(Input):
    scope: Literal["local_observation"]
    granted: bool


class Observation(Input):
    captureId: Identifier
    capturedAt: AwareDatetime
    methodVersion: Annotated[str, Field(min_length=1, max_length=80)]
    coordinateSpace: Literal["image", "user", "unknown"]
    quality: Literal["usable", "poor", "unknown"]


class VisionRequest(Input):
    sessionId: Identifier | None = None
    task: Literal["cheek_color_balance", "lip_color"]
    authorization: Consent
    observation: Observation


class Preference(Input):
    key: Literal["finish", "fragrance", "tools"]
    value: Annotated[str, Field(min_length=1, max_length=240, pattern=r"\S")]


class NewPreference(Input):
    operation: Literal["create"]
    preference: Preference


class PreferenceCorrection(Input):
    operation: Literal["correct"]
    memoryId: Identifier
    expectedVersion: Version
    preference: Preference


class PreferenceConfirmation(Input):
    proposalId: Identifier
    expectedVersion: Version
    confirmed: bool


AGENT = TypeAdapter(AgentRequest)
VISION = TypeAdapter(VisionRequest)
PROPOSAL = TypeAdapter(Annotated[NewPreference | PreferenceCorrection, Field(discriminator="operation")])
CONFIRM = TypeAdapter(PreferenceConfirmation)


async def read_json(request, adapter):
    if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "application/json":
        raise Fault(415, "请提交 application/json。")
    buffer = bytearray()
    async for chunk in request.stream():
        if len(buffer) + len(chunk) > 16_384:
            raise Fault(413, "请求内容超过 16 KiB。")
        buffer.extend(chunk)
    try:
        value = adapter.validate_json(buffer)
        if isinstance(value, (AgentRequest, VisionRequest)) and value.sessionId is None and "sessionId" in value.model_fields_set:
            raise ValueError("null session")
        return value
    except (ValueError, ValidationError):
        raise Fault(400, "请求不符合 v1 契约。") from None


def product_filters(query):
    category = query.getlist("category")
    ids = query.getlist("ids")
    if (set(query) - {"category", "ids"} or len(category) > 1
            or (category and category[0] not in ("face", "lips", "tools"))
            or len(ids) > 10 or len(ids) != len(set(ids))
            or any(not re.fullmatch(ID_PATTERN, item) for item in ids)):
        raise Fault(400, "产品筛选条件不符合 v1 契约。")
    return next(iter(category), None), ids
