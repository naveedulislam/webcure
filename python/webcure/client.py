"""
WebCure API client — communicates with the WebCure VS Code extension API server.
"""

import requests


class WebCure:
    def __init__(self, port: int = 5678, host: str = "127.0.0.1"):
        self.base_url = f"http://{host}:{port}"

    def invoke(self, tool: str, params: dict | None = None) -> str:
        if params is None:
            params = {}
        payload = {"tool": tool, "params": params}
        try:
            response = requests.post(f"{self.base_url}/invoke", json=payload, timeout=60)
            response.raise_for_status()
            data = response.json()
            if not data.get("success"):
                raise RuntimeError(f"WebCure error: {data.get('error', 'unknown')}")
            return data.get("output", "")
        except requests.exceptions.ConnectionError:
            raise ConnectionError(
                f"Cannot connect to WebCure API at {self.base_url}. "
                "Start the API server in VS Code: Command Palette → 'WebCure: Start API Server'"
            )

    def health(self) -> bool:
        try:
            r = requests.get(f"{self.base_url}/health", timeout=5)
            r.raise_for_status()
            return r.json().get("status") == "ok"
        except Exception:
            return False

    def tools(self) -> list[str]:
        r = requests.get(f"{self.base_url}/tools", timeout=5)
        r.raise_for_status()
        return r.json().get("tools", [])
