from .nodes.panel_layout_provider import PanelLayoutProvider
from .nodes.panel_compositor import PanelCompositor
from .nodes.list_utils import ListGetItem, TupleUnpack

NODE_CLASS_MAPPINGS = {
    "PanelLayoutProvider": PanelLayoutProvider,
    "PanelCompositor": PanelCompositor,
    "ListGetItem": ListGetItem,
    "TupleUnpack": TupleUnpack,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "PanelLayoutProvider": "Panel Layout Provider (Manga)",
    "PanelCompositor": "Panel Compositor (Manga)",
    "ListGetItem": "List Get Item",
    "TupleUnpack": "Tuple Unpack",
}

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
