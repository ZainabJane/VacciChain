import os
from contextlib import asynccontextmanager

import httpx
import structlog
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from routes.analytics import router as analytics_router
from routes.batch import router as batch_router
from scheduler import start_scheduler, stop_scheduler
from schemas import HealthResponse

structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.make_filtering_bound_logger(
        getattr(__import__("logging"), os.getenv("LOG_LEVEL", "INFO"))
    ),
)

logger = structlog.get_logger(service="python-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()


app = FastAPI(title="VacciChain Analytics", version="1.0.0", lifespan=lifespan)

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.include_router(analytics_router, prefix="/analytics")
app.include_router(batch_router, prefix="/batch")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    response = await call_next(request)
    logger.info("request", method=request.method, path=request.url.path, status=response.status_code)
    return response


@app.get("/health")
def health():
    return HealthResponse(status="ok")


@app.get("/ready")
async def ready():
    backend_url = os.getenv("BACKEND_URL", "http://backend:3000")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"{backend_url}/health")
        if response.status_code != 200:
            logger.warning("readiness_failed", dependency="backend", status=response.status_code)
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "dependency": "backend"},
            )
    except httpx.HTTPError as exc:
        logger.warning("readiness_failed", dependency="backend", error=str(exc))
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "dependency": "backend"},
        )
    return {"status": "ready"}
