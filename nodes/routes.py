"""HTTP routes for Phase 2's "Draw Panels" dialog (PHASE2_SPEC.md §10).

Registering routes has a side effect (adds handlers to ComfyUI's shared
aiohttp app) — this module just needs to be imported once for that to take
effect; see __init__.py.
"""

import json

from aiohttp import web
from server import PromptServer

from ..presets.layouts import delete_user_layout, save_user_layout

routes = PromptServer.instance.routes


@routes.get("/panelcomposer/all_layouts")
async def get_all_layouts(request):
    # Re-imported fresh each request rather than captured at module-import
    # time — save_user_layout() rebinds presets.layouts._PRESETS to a new
    # dict object after every save, so the module-level name here would go
    # stale after the first save otherwise.
    from ..presets import layouts

    return web.json_response(layouts._PRESETS)


@routes.post("/panelcomposer/save_user_layout")
async def post_save_user_layout(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"success": False, "error": "request body must be a JSON object"}, status=400)

    try:
        key, choice = save_user_layout(
            category=body.get("category"),
            label=body.get("label"),
            panels=body.get("panels"),
            reading_groups=body.get("reading_groups"),
        )
    except ValueError as err:
        return web.json_response({"success": False, "error": str(err)}, status=400)
    except Exception as err:  # noqa: BLE001 - report unexpected failures to the caller instead of a bare 500
        return web.json_response({"success": False, "error": f"save failed: {err}"}, status=500)

    return web.json_response({"success": True, "key": key, "choice": choice})


@routes.post("/panelcomposer/delete_user_layout")
async def post_delete_user_layout(request):
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"success": False, "error": "invalid JSON body"}, status=400)
    if not isinstance(body, dict):
        return web.json_response({"success": False, "error": "request body must be a JSON object"}, status=400)

    try:
        delete_user_layout(key=body.get("key"))
    except ValueError as err:
        return web.json_response({"success": False, "error": str(err)}, status=400)
    except Exception as err:  # noqa: BLE001 - report unexpected failures to the caller instead of a bare 500
        return web.json_response({"success": False, "error": f"delete failed: {err}"}, status=500)

    return web.json_response({"success": True})
