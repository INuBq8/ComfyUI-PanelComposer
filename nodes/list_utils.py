"""Generic list/tuple indexing utilities — ComfyUI has no built-in node for
this, so PANEL_DIMENSIONS (and any other list/tuple-shaped custom type)
needs one to be consumable downstream (e.g. wiring one panel's (w, h) into
EmptyLatentImage's width/height INT inputs)."""


class ListGetItem:
    """Indexes into any list or tuple. `*` is ComfyUI's built-in wildcard
    type (comfy_api.latest.IO.AnyType) — the server's link validation
    special-cases it to match any other type, so this connects to/from any
    socket, not just PANEL_DIMENSIONS."""

    CATEGORY = "utils/list"
    FUNCTION = "get_item"
    RETURN_TYPES = ("*",)
    RETURN_NAMES = ("item",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "list_or_tuple": ("*", {}),
                "index": ("INT", {"default": 0, "min": -1_000_000, "max": 1_000_000, "step": 1}),
            }
        }

    def get_item(self, list_or_tuple, index):
        try:
            return (list_or_tuple[index],)
        except (IndexError, TypeError, KeyError) as e:
            length = len(list_or_tuple) if hasattr(list_or_tuple, "__len__") else "unknown"
            raise ValueError(
                f"List Get Item: failed to index into input (length={length}) at index {index}: {e}"
            )


class TupleUnpack:
    """Splits a tuple/list into up to 4 individual `*`-typed outputs (e.g. a
    PANEL_DIMENSIONS item's (width, height) into separate INT-compatible
    sockets). Missing positions (fewer than 4 elements) output None."""

    CATEGORY = "utils/list"
    FUNCTION = "unpack"
    RETURN_TYPES = ("*", "*", "*", "*")
    RETURN_NAMES = ("item_0", "item_1", "item_2", "item_3")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "tuple_or_list": ("*", {}),
            }
        }

    def unpack(self, tuple_or_list):
        items = list(tuple_or_list)
        items = (items + [None, None, None, None])[:4]
        return tuple(items)


NODE_CLASS_MAPPINGS = {
    "ListGetItem": ListGetItem,
    "TupleUnpack": TupleUnpack,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "ListGetItem": "List Get Item",
    "TupleUnpack": "Tuple Unpack",
}
