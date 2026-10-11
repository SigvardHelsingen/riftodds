"""Load local settings before modules capture environment-based configuration."""
import os
from pathlib import Path


def load_env(path=None):
    """Load a local env file without overriding the process environment."""
    env = Path(path) if path is not None else Path(__file__).with_name(".env")
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
