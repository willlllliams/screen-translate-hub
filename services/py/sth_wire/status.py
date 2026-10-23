"""Status codes and failure classes (spec 08 section 7)."""

from __future__ import annotations

from dataclasses import dataclass

WHOLE = {"unavailable", "rate_limited", "quota_exceeded", "incompatible", "unimplemented", "permission_denied"}
SEGMENT = {"deadline_exceeded", "invalid_argument", "not_found", "engine_error", "internal"}


@dataclass(frozen=True)
class Status:
    code: str
    message: str | None = None
    retry_after_ms: int | None = None


OK = Status("ok")


def failure_class(code: str) -> str | None:
    if code in WHOLE:
        return "whole"
    if code in SEGMENT:
        return "segment"
    return None


class RpcError(Exception):
    def __init__(self, code: str, message: str | None = None, retry_after_ms: int | None = None):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.detail = message
        self.retry_after_ms = retry_after_ms

    @classmethod
    def from_status(cls, s: Status) -> "RpcError":
        return cls(s.code, s.message, s.retry_after_ms)

    def to_status(self) -> Status:
        return Status(self.code, self.detail, self.retry_after_ms)


def status_of(err: BaseException) -> Status:
    if isinstance(err, RpcError):
        return err.to_status()
    import asyncio

    if isinstance(err, asyncio.CancelledError):
        return Status("cancelled")
    return Status("internal", f"{type(err).__name__}: {err}")
