"""Compose only the pinned V1 services required by the V2 local API."""

from contextlib import asynccontextmanager
from pathlib import Path
import os

from app.agent.harness import AgentHarness
from app.agent.state import SessionStore
from app.config import ROOT, Settings
from app.looks.service import LookService
from app.memory.migrations import migrate, prune_progress
from app.memory.store import MemoryStore
from app.products.service import ProductService
from app.rag.knowledge import KnowledgeStore

from .api import create_api


def create_app():
    # Passing explicit settings keeps the adapter independent of any V1 environment file or supplier keys.
    settings = Settings(
        model_provider="mock", vision_provider="mock", reading_provider="mock", reference_provider="mock",
        embedding_provider="mock", reranker_provider="mock", allow_remote_ai=False, research_mode=False,
        admin_enabled=False, developer_mode=True, api_key="", deepseek_api_key="", compatible_api_key="",
        memory_path=Path(os.environ["TRACE_LIVE_DB"]),
    )
    if ROOT.resolve() != Path(os.environ["TRACE_LIVE_UPSTREAM"]).resolve():
        raise RuntimeError("Imported V1 source does not match the prepared copy")
    memory = MemoryStore(settings.memory_path)
    migrate(memory)
    knowledge = KnowledgeStore(settings.knowledge_dir)
    sessions = SessionStore()
    sessions.memory = memory
    # HTTP routes only invoke the deterministic course, knowledge and memory code. No retrieval or vision provider is attached.
    agent = AgentHarness(settings, sessions, knowledge, None,
                         LookService(knowledge, settings), ProductService(knowledge, settings), memory, None)

    @asynccontextmanager
    async def lifespan(_api):
        yield
        with memory.connect() as db:
            prune_progress(db)

    return create_api(agent, os.environ["TRACE_LIVE_TOKEN"], int(os.environ["TRACE_LIVE_PORT"]), lifespan)
