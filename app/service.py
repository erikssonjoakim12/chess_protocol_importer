"""The pipeline: photos -> reading -> plies -> resolved moves -> PGN."""
from .pgn_builder import build_pgn, derive_result
from .readers import flatten, get_reader, normalize_reading
from .resolver import resolve


def process(headers, plies, end_marker=None):
    """Resolve plies and build the PGN. Called after reading and after every edit.

    If headers["result"] is set (the user chose it) it is used as is,
    otherwise the result is worked out from the scoresheet.
    """
    resolution = resolve(plies)
    mate_winner = None
    if resolution["checkmate"]:
        mate_winner = "black" if resolution["next_color"] == "white" else "white"
    derived, warning = derive_result(headers, end_marker, mate_winner)
    result = (headers.get("result") or "").strip() or derived
    pgn = build_pgn(headers, resolution["plies"], result)
    return {
        "resolution": resolution,
        "result": result,
        "derived_result": derived,
        "result_warning": warning,
        "pgn": pgn,
    }


def read_photos(images, reader_name=None, careful=False):
    """`images` is a list of (bytes, mime_type), in page order."""
    reader = get_reader(reader_name, careful=careful)
    reading = normalize_reading(reader.read(images))
    plies = flatten(reading)
    headers = dict(reading["headers"])
    out = process(headers, plies, reading["end_marker"])
    headers["result"] = out["result"]
    out.update({
        "reader": reader.name + (" (%s)" % ", ".join(sorted(reader.used_models))
                                 if getattr(reader, "used_models", None) else ""),
        "headers": headers,
        "end_marker": reading["end_marker"],
        "notes": reading["notes"],
        "header_flags": reading["header_flags"],
    })
    return out
