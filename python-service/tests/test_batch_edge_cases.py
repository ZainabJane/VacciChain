"""
Edge case / null value tests for POST /batch/verify.
Closes #345
"""

import asyncio

import pytest
from httpx import AsyncClient, ASGITransport
from main import app


@pytest.mark.asyncio
async def test_batch_verify_empty_wallet_list_returns_error():
    """Empty wallet list is rejected by schema validation (min_length=1)."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": []})
    # Pydantic min_length=1 → FastAPI returns 422 Unprocessable Entity
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_batch_verify_missing_wallets_field():
    """Request body without 'wallets' field is rejected."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={})
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_batch_verify_null_wallets_field():
    """Request body with null 'wallets' is rejected."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": None})
    assert res.status_code == 422


@pytest.mark.asyncio
async def test_batch_verify_over_limit():
    """More than 100 wallets returns 400."""
    wallets = [f"GADDR{str(i).zfill(51)}" for i in range(101)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": wallets})
    assert res.status_code in (400, 422)


@pytest.mark.asyncio
async def test_batch_verify_over_configured_limit_returns_400():
    """Batch size above the configured limit is rejected with 400."""
    from main import MAX_BATCH_SIZE

    wallets = [f"GADDR{str(i).zfill(51)}" for i in range(MAX_BATCH_SIZE + 1)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": wallets})
    assert res.status_code == 400
    body = res.json()
    assert "detail" in body


@pytest.mark.asyncio
async def test_batch_verify_concurrency_is_bounded(monkeypatch):
    """Concurrent in-flight verifications never exceed the configured parallelism."""
    import main

    limit = getattr(main, "MAX_CONCURRENCY", 5)
    state = {"current": 0, "peak": 0}

    async def fake_verify(wallet):
        state["current"] += 1
        state["peak"] = max(state["peak"], state["current"])
        try:
            await asyncio.sleep(0.01)
            return {"wallet": wallet, "valid": True}
        finally:
            state["current"] -= 1

    monkeypatch.setattr(main, "verify_wallet", fake_verify, raising=False)

    wallets = [f"GADDR{str(i).zfill(51)}" for i in range(min(limit * 3, 30))]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": wallets})

    assert res.status_code == 200
    assert state["peak"] <= limit


@pytest.mark.asyncio
async def test_batch_verify_partial_failure_reports_per_item_error(monkeypatch):
    """A failing item yields a per-item error without failing the whole batch."""
    import main

    async def fake_verify(wallet):
        if wallet.endswith("1"):
            raise RuntimeError("boom")
        return {"wallet": wallet, "valid": True}

    monkeypatch.setattr(main, "verify_wallet", fake_verify, raising=False)

    wallets = [
        f"GADDR{str(i).zfill(50)}1" if i % 2 else f"GADDR{str(i).zfill(51)}"
        for i in range(4)
    ]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": wallets})

    assert res.status_code == 200
    results = res.json().get("results", res.json())
    assert isinstance(results, list)
    assert len(results) == len(wallets)
    errored = [r for r in results if r.get("error")]
    assert errored, "expected at least one per-item error"
    for item in errored:
        assert "boom" not in str(item.get("error", ""))


@pytest.mark.asyncio
async def test_batch_verify_propagates_request_id():
    """Incoming request ID is echoed back on the response."""
    request_id = "test-request-id-12345"
    wallets = [f"GADDR{str(i).zfill(51)}" for i in range(2)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post(
            "/batch/verify",
            json={"wallets": wallets},
            headers={"X-Request-ID": request_id},
        )
    assert res.status_code == 200
    assert res.headers.get("X-Request-ID") == request_id


@pytest.mark.asyncio
async def test_batch_verify_generates_request_id_when_absent():
    """A request ID is generated and returned when the client does not supply one."""
    wallets = [f"GADDR{str(i).zfill(51)}" for i in range(2)]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        res = await client.post("/batch/verify", json={"wallets": wallets})
    assert res.status_code == 200
    generated = res.headers.get("X-Request-ID")
    assert generated
    assert "Traceback" not in generated
