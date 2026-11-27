import os
from collections import defaultdict
from fastapi import APIRouter, Depends, HTTPException
import httpx
from auth import require_analytics_auth

router = APIRouter(tags=["Analytics"], dependencies=[Depends(require_analytics_auth)])

BACKEND_URL = os.getenv("BACKEND_URL", "http://backend:4000")
# Anomaly threshold: flag issuers with more than this many mints in the dataset
ANOMALY_THRESHOLD = int(os.getenv("ANOMALY_THRESHOLD", "50"))


async def _fetch_events(event_type: str, limit: int = 500) -> list:
    """
    Fetch events from the backend API.

    Args:
        event_type (str): The type of event to fetch (e.g., "VaccinationMinted")
        limit (int): Maximum number of events to retrieve (default: 500)

    Returns:
        list: A list of event dictionaries

    Raises:
        httpx.HTTPError: If the backend API request fails
    """
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{BACKEND_URL}/events",
            params={"event_type": event_type, "limit": limit},
            timeout=10,
        )
        res.raise_for_status()
        return res.json().get("events", [])


async def check_backend_readiness() -> dict:
    """
    Lightweight readiness probe for the analytics service.

    Verifies that the backend dependency is reachable by issuing a minimal
    request. This is used by the python-service readiness endpoint so that
    failed dependency readiness removes the task from traffic without
    masking process crashes (exceptions propagate to the caller).

    Returns:
        dict: A dictionary containing:
            - ready (bool): True when the backend responded successfully
            - backend_url (str): The backend URL that was probed

    Raises:
        httpx.HTTPError: If the backend API request fails
    """
    async with httpx.AsyncClient() as client:
        res = await client.get(
            f"{BACKEND_URL}/events",
            params={"event_type": "VaccinationMinted", "limit": 1},
            timeout=5,
        )
        res.raise_for_status()
    return {"ready": True, "backend_url": BACKEND_URL}


@router.get("/ready")
async def readiness():
    """
    Readiness endpoint for the analytics service.

    Probes the backend dependency and reports readiness. Returns HTTP 503
    when the backend is unreachable so orchestrators can remove the task
    from traffic.

    Returns:
        dict: A dictionary containing:
            - ready (bool): True when the backend responded successfully
            - backend_url (str): The backend URL that was probed

    Raises:
        HTTPException: If the backend API is unreachable
    """
    try:
        return await check_backend_readiness()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Backend dependency not ready: {exc}",
        ) from exc


@router.get("/rates")
async def vaccination_rates():
    """
    Get vaccination counts grouped by vaccine name.

    Fetches all VaccinationMinted events from the backend and aggregates
    the count of mints per vaccine type.

    Returns:
        dict: A dictionary containing:
            - rates (dict): Vaccine name -> count mapping
            - total_mints (int): Total number of vaccination mints

    Raises:
        HTTPException: If the backend API is unreachable
    """
    events = await _fetch_events("VaccinationMinted")
    counts: dict[str, int] = defaultdict(int)
    for e in events:
        vaccine = e.get("payload", {}).get("vaccine_name") or e.get("payload", {}).get("1")
        if vaccine:
            counts[str(vaccine)] += 1
    return {"rates": dict(counts), "total_mints": len(events)}


@router.get("/issuers")
async def issuer_activity():
    """
    Get issuer activity statistics.

    Fetches all VaccinationMinted events and aggregates statistics per issuer,
    including total mints and the most recent ledger where they minted.

    Returns:
        dict: A dictionary containing:
            - issuers (list): List of issuer statistics, each containing:
                - issuer (str): Issuer address
                - total_issued (int): Total number of mints by this issuer
                - last_ledger (int): Most recent ledger where this issuer minted

    Raises:
        HTTPException: If the backend API is unreachable
    """
    events = await _fetch_events("VaccinationMinted")
    stats: dict[str, dict] = {}
    for e in events:
        issuer = e.get("payload", {}).get("issuer") or e.get("payload", {}).get("2")
        if not issuer:
            continue
        issuer = str(issuer)
        if issuer not in stats:
            stats[issuer] = {"issuer": issuer, "total_issued": 0, "last_ledger": 0}
        stats[issuer]["total_issued"] += 1
        if e.get("ledger", 0) > stats[issuer]["last_ledger"]:
            stats[issuer]["last_ledger"] = e["ledger"]
    return {"issuers": list(stats.values())}


@router.get("/anomalies")
async def anomaly_detection():
    """
    Detect anomalous issuer activity.

    Flags issuers whose total mint count exceeds the ANOMALY_THRESHOLD.
    This can help identify suspicious or unusual minting patterns.

    Returns:
        dict: A dictionary containing:
            - flagged_issuers (list): List of issuers exceeding the threshold, each containing:
                - issuer (str): Issuer address
                - total_issued (int): Total number of mints by this issuer
            - threshold (int): The anomaly threshold value

    Raises:
        HTTPException: If the backend API is unreachable
    """
    events = await _fetch_events("VaccinationMinted")
    counts: dict[str, int] = defaultdict(int)
    for e in events:
        issuer = e.get("payload", {}).get("issuer") or e.get("payload", {}).get("2")
        if issuer:
            counts[str(issuer)] += 1
    flagged = [
        {"issuer": issuer, "total_issued": count}
        for issuer, count in counts.items()
        if count > ANOMALY_THRESHOLD
    ]
    return {"flagged_issuers": flagged, "threshold": ANOMALY_THRESHOLD}
