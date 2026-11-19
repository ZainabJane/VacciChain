import os
import re
import uuid
from contextlib import asynccontextmanager
from contextvars import ContextVar

import structlog
from fastapi import FastAPI, Request
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from routes.analytics import router as analytics_router
from routes.batch import router as batch_router
from scheduler import start_scheduler, stop_scheduler
from schemas import HealthResponse

REQUEST_ID_HEADER = "X-Request-ID"
# Accept only safe, bounded identifiers from clients; anything else is replaced.
_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

request_id_ctx: ContextVar[str] = ContextVar("request_id", default="-")


def get_request_id() -> str:
    """Return the current request's correlation ID (for downstream calls)."""
    return request_id_ctx.get()


def _bind_request_id(logger, method_name, event_dict):
    event_dict.setdefault("request_id", request_id_ctx.get())
    return event_dict


def _resolve_request_id(raw: str | None) -> str:
    if raw and _REQUEST_ID_PATTERN.match(raw):
        return raw
    return uuid.uuid4().hex


structlog.configure(
    processors=[
        structlog.stdlib.add_log_level,
        _bind_request_id,
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
    request_id = _resolve_request_id(request.headers.get(REQUEST_ID_HEADER))
    request.state.request_id = request_id
    token = request_id_ctx.set(request_id)
    try:
        response = await call_next(request)
        logger.info(
            "request",
            method=request.method,
            path=request.url.path,
            status=response.status_code,
            request_id=request_id,
        )
        response.headers[REQUEST_ID_HEADER] = request_id
        return response
    finally:
        request_id_ctx.reset(token)


@app.get("/health")
def health():
    return HealthResponse(status="ok")
