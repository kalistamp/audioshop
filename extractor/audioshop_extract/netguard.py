"""Outbound HTTP for article links, screened the same way BeatPods screens imports.

The job server fetches URLs a visitor typed, so every connection is checked before the socket opens:
  - http/https only, at most MAX_REDIRECTS hops, each hop re-checked;
  - every address a hostname resolves to must be public: loopback, private, link-local (cloud
    metadata), carrier-grade NAT (Tailscale's 100.64/10) and reserved ranges are refused;
  - the socket connects to the address that was vetted (no second DNS lookup), so a name that
    re-resolves to 127.0.0.1 between check and connect gets nowhere;
  - the body is capped at MAX_BYTES.
Set AUDIOSHOP_ALLOW_PRIVATE_HOSTS=1 to fetch from your own LAN.
"""

from __future__ import annotations

import http.client
import ipaddress
import os
import socket
import ssl
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

MAX_BYTES = 8 * 1024 * 1024
MAX_REDIRECTS = 5
TIMEOUT_S = 20
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Mobile Safari/537.36"
)
_EXTRA_BLOCKED = [ipaddress.ip_network(n) for n in ("100.64.0.0/10", "192.0.0.0/24", "198.18.0.0/15")]


class FetchError(Exception):
    """A user-facing reason the page could not be fetched."""


@dataclass
class Fetched:
    url: str
    status: int
    content_type: str
    body: bytes


def private_hosts_allowed() -> bool:
    return os.environ.get("AUDIOSHOP_ALLOW_PRIVATE_HOSTS") == "1"


def is_blocked(ip: str) -> bool:
    addr = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return (
        addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_multicast
        or addr.is_reserved or addr.is_unspecified or any(addr in net for net in _EXTRA_BLOCKED)
    )


def vetted_address(host: str, port: int) -> str:
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise FetchError(f"Could not find the site {host}.") from exc
    addresses = [info[4][0] for info in infos]
    if not private_hosts_allowed():
        blocked = [a for a in addresses if is_blocked(a)]
        if blocked:
            raise FetchError(f"Refusing to fetch from the private address {blocked[0]}.")
    return addresses[0]


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, ip: str, **kwargs):
        super().__init__(host, **kwargs)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, ip: str, **kwargs):
        super().__init__(host, context=ssl.create_default_context(), **kwargs)
        self._ip = ip

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def fetch(url: str) -> Fetched:
    for _ in range(MAX_REDIRECTS + 1):
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise FetchError("Only http and https links can be read.")
        port = parts.port or (443 if parts.scheme == "https" else 80)
        ip = vetted_address(parts.hostname, port)
        cls = _PinnedHTTPSConnection if parts.scheme == "https" else _PinnedHTTPConnection
        conn = cls(parts.hostname, ip, port=port, timeout=TIMEOUT_S)
        path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
        try:
            conn.request("GET", path, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
                "Accept-Language": "en-US,en;q=0.8",
                "Accept-Encoding": "identity",
            })
            resp = conn.getresponse()
            if resp.status in (301, 302, 303, 307, 308):
                location = resp.getheader("Location")
                if not location:
                    raise FetchError("The site sent a redirect without a destination.")
                url = urljoin(url, location)
                continue
            if resp.status >= 400:
                hint = " The site may block automated readers or need a login." if resp.status in (401, 403, 429) else ""
                raise FetchError(f"The site answered {resp.status}.{hint}")
            body = resp.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise FetchError("That page is larger than 8 MB.")
            return Fetched(url, resp.status, (resp.getheader("Content-Type") or "").lower(), body)
        except (OSError, http.client.HTTPException) as exc:
            if isinstance(exc, FetchError):
                raise
            raise FetchError(f"Could not download the page ({type(exc).__name__}).") from exc
        finally:
            conn.close()
    raise FetchError("Too many redirects.")
