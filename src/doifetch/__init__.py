"""doi-fetch: DOI in, full-text PDF + supplementary materials out."""

from .fetch import fetch
from .models import Metadata, Report

__version__ = "0.6.0"
__all__ = ["fetch", "Metadata", "Report", "__version__"]
