import asyncio
import os
import httpx
from fastapi import APIRouter, HTTPException, Request
from slowapi import Limiter
from slowapi.util import get_remote_address
from schemas import BatchVerifyRequest, BatchVerifyResponse, WalletResult

router = APIRouter(tags=["Batch"])
limiter = Limiter(key_func=get_remote_address)

BACKEND_URL = os.getenv("BACKEND_URL", "http://backend:4000")


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """Read a bounded integer from the environment, clamped to documented limits."""
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


# Documented limits: batch size 1..100, concurrency 1..20.
BATCH_MAX_SIZE = _env_int("BATCH_MAX_SIZE", 100, 1, 100)
BATCH_CONCURRENCY = _env_int("BATCH_CONCURRENCY", 5, 1, 20)


@router.post(
    "/verify",
    response_model=BatchVerifyResponse,
    summary="Bulk verify Stellar wallet vaccination status",
    description=(
        "Accepts up to **100** Stellar public-key addresses and returns the vaccination "
        "status for each one by querying the on-chain verification endpoint.\n\n"
        "- Each address must be a valid Stellar public key starting with `G`.\n"
        "- Wallets that cannot be reached are returned with an `error` field instead of "
        "`vaccinated`/`record_count`.\n\n"
        "**Auth:** No authentication required — mirrors the public `/verify/:wallet` endpoint."
    ),
    responses={
        400: {"description": "Request contains more than 100 wallets"},
        429: {"description": "Rate limit exceeded"},
    },
)
@limiter.limit("30/minute")
async def batch_verify(request: Request, body: BatchVerifyRequest):
    """
    Verify vaccination status for multiple wallets in a single request.

    Accepts a list of Stellar wallet addresses and returns their vaccination status
    by querying the backend's public verification endpoint for each wallet.

    Args:
        request (BatchVerifyRequest): Request containing a list of wallet addresses

    Returns:
        BatchVerifyResponse: Response containing verification results for each wallet

    Raises:
        HTTPException: 400 if more than 100 wallets are provided
        HTTPException: 500 if the backend API is unreachable

    Note:
        - Maximum 100 wallets per request
        - No authentication required
        - Individual wallet lookup failures do not fail the entire request
    """
    if len(body.wallets) > BATCH_MAX_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {BATCH_MAX_SIZE} wallets per request",
        )

    request_id = getattr(request.state, "request_id", None) or request.headers.get("X-Request-ID")
    headers = {"X-Request-ID": request_id} if request_id else {}

    semaphore = asyncio.Semaphore(BATCH_CONCURRENCY)

    async def verify_one(client: httpx.AsyncClient, wallet: str) -> WalletResult:
        async with semaphore:
            try:
                res = await client.get(
                    f"{BACKEND_URL}/verify/{wallet}", timeout=10, headers=headers
                )
                data = res.json()
                return WalletResult(
                    wallet=wallet,
                    vaccinated=data.get("vaccinated", False),
                    record_count=data.get("record_count", 0),
                )
            except Exception as e:
                return WalletResult(wallet=wallet, error=str(e))

    async with httpx.AsyncClient() as client:
        results: list[WalletResult] = await asyncio.gather(
            *(verify_one(client, wallet) for wallet in body.wallets)
        )

    return BatchVerifyResponse(results=results, total=len(results))
