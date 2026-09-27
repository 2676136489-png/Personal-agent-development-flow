"""Router aggregation.

每新增一个模块只需在这里 include 一行，main.py 不需要改动。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.routes.agent import router as agent_router
from app.api.routes.debug import router as debug_router
from app.api.routes.graph import router as graph_router
from app.api.routes.health import router as health_router
from app.api.routes.knowledge import router as knowledge_router
from app.api.routes.llm import router as llm_router
from app.api.routes.research import router as research_router
from app.api.routes.settings import router as settings_router

api_router = APIRouter()
api_router.include_router(health_router)
api_router.include_router(research_router)
api_router.include_router(agent_router)
api_router.include_router(knowledge_router)
api_router.include_router(graph_router)
api_router.include_router(settings_router)
api_router.include_router(llm_router)
api_router.include_router(debug_router)
