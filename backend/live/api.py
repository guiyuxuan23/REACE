"""The standalone v1 HTTP surface for same-machine native frontend integration."""

from datetime import datetime, timezone
from hashlib import sha256
from hmac import compare_digest
import re
import sqlite3
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from app.knowledge.policy import is_reviewed

from .coaching import CoachingTurns
from .contracts import AGENT, CONFIRM, ID_PATTERN, PROPOSAL, VISION, Fault, product_filters, read_json
from .preferences import Preferences


ERROR_CODES = {
    400: "BAD_REQUEST", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED", 409: "CONFLICT", 413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE", 500: "INTERNAL_ERROR", 503: "UNAVAILABLE",
}
PRODUCT_CATEGORIES = {"base": "face", "blush": "face", "lip": "lips", "brush": "tools"}


def envelope(request, data, status=200):
    return send(request, {"data": data}, status)


def send(request, payload, status):
    incoming = request.headers.get("X-Request-Id", "")
    request_id = incoming if re.fullmatch(ID_PATTERN, incoming) else str(uuid4())
    headers = {"Cache-Control": "no-store"}
    if status == 401:
        headers["WWW-Authenticate"] = "Bearer"
    return JSONResponse({"meta": {"apiVersion": "v1", "source": "live", "requestId": request_id}, **payload},
                        status_code=status, headers=headers)


def failure(request, fault):
    return send(request, {"error": {"code": ERROR_CODES[fault.status], "message": str(fault),
                                    "retryable": fault.retryable}}, fault.status)


def catalog(agent, category, ids):
    known = agent.products.available_products()
    candidates = (known[key] for key in ids if key in known) if ids else known.values()
    items = []
    for product in candidates:
        mapped = PRODUCT_CATEGORIES.get(product["category"])
        if (not mapped or (category and category != mapped) or not is_reviewed(product)
                or product.get("source_type") == "sample" or not product["name"]):
            continue
        source = next((row for row in agent.products.sources(product)
                       if row["title"] and row["url"].startswith("https://") and urlsplit(row["url"]).hostname), None)
        if source:
            items.append({"id": product["product_id"], "name": product["name"], "category": mapped,
                          "attributes": {"shade": None, "finish": product.get("finish") or None},
                          "provenance": {"status": "verified", "title": source["title"], "url": source["url"]}})
    return {"items": items[:100]}


def create_api(agent, token, port, lifespan):
    api = FastAPI(title="TRACE V2 local live API", docs_url=None, redoc_url=None,
                  openapi_url=None, redirect_slashes=False, lifespan=lifespan)
    bearer = f"Bearer {token}".encode()
    owner = "trace_v2_" + sha256(token.encode()).hexdigest()
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
    if port == 80:
        allowed_hosts.update({"127.0.0.1", "localhost"})
    turns = CoachingTurns(agent)
    preferences = Preferences(agent)

    @api.middleware("http")
    async def security_boundary(request: Request, call_next):
        if request.headers.get("host", "").lower() not in allowed_hosts or "origin" in request.headers:
            return failure(request, Fault(403, "此联调服务只接受同机原生客户端。"))
        if request.url.path != "/health" and not compare_digest(
            request.headers.get("authorization", "").encode(), bearer,
        ):
            return failure(request, Fault(401, "需要有效的本机开发令牌。"))
        return await call_next(request)

    @api.exception_handler(Fault)
    async def expected_error(request, fault):
        return failure(request, fault)

    @api.exception_handler(HTTPException)
    async def http_error(request, exc):
        if exc.status_code == 404:
            return failure(request, Fault(404, "接口不存在。"))
        if exc.status_code == 405:
            response = failure(request, Fault(405, "此接口不接受该请求方法。"))
            if exc.headers and "Allow" in exc.headers:
                response.headers["Allow"] = exc.headers["Allow"]
            return response
        return failure(request, Fault(500, "本机服务未能处理请求。"))

    @api.exception_handler(Exception)
    async def internal_error(request, exc):
        return failure(request, Fault(500, "本机服务未能处理请求。"))

    @api.get("/health")
    def health(request: Request):
        try:
            memory = "healthy" if agent.memory.healthy() else "unhealthy"
        except sqlite3.Error:
            memory = "unhealthy"
        return envelope(request, {"status": "alive", "dependencies": {
            "agent": "healthy" if agent.coaching.knowledge("zh-CN", reviewed_only=False) else "unhealthy",
            "vision": "unchecked", "memory": memory, "products": "healthy" if agent.store.products else "unhealthy",
        }})

    @api.post("/api/v1/agent/message")
    async def agent_message(request: Request):
        data = await read_json(request, AGENT)
        return envelope(request, await run_in_threadpool(turns.send, owner, data))

    @api.post("/api/v1/vision/analyze")
    async def vision(request: Request):
        data = await read_json(request, VISION)
        if not data.authorization.granted:
            raise Fault(403, "须先同意本机单帧检查。")
        if data.sessionId:
            await run_in_threadpool(turns.session, owner, data.sessionId)
        age = (datetime.now(timezone.utc) - data.observation.capturedAt).total_seconds()
        if not -5 <= age <= 30:
            raise Fault(409, "采集时间已失效，请重新采集。")
        raise Fault(503, "原生设备的视觉分析尚未接入。当前没有可报告的观察结果。")

    @api.get("/api/v1/products")
    def products(request: Request):
        return envelope(request, catalog(agent, *product_filters(request.query_params)))

    @api.get("/api/v1/memory/profile")
    def memory_profile(request: Request):
        return envelope(request, preferences.profile(owner))

    @api.post("/api/v1/memory/proposals")
    async def propose(request: Request):
        data = await read_json(request, PROPOSAL)
        return envelope(request, await run_in_threadpool(preferences.propose, owner, data), 201)

    @api.post("/api/v1/memory/confirm")
    async def confirm(request: Request):
        data = await read_json(request, CONFIRM)
        return envelope(request, await run_in_threadpool(preferences.confirm, owner, data))

    @api.delete("/api/v1/memory/{memory_id}")
    def delete(request: Request, memory_id: str):
        if not re.fullmatch(ID_PATTERN, memory_id):
            raise Fault(400, "无效的偏好 ID。")
        return envelope(request, preferences.delete(owner, memory_id))

    return api
