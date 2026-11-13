#!/usr/bin/env python3
"""The decision model's training (docs/RFC_CUSTOM_MODEL.md step 3; owner 2026-11-13: "1-3").

Reads the labeled rows of the custom model's dataset (src/model-dataset.mjs, fetched by
scripts/fetch-dataset.mjs into a file outside the repository) and trains one LightGBM classifier per
label set and side: does price reach the target before the stop from this decision's close?

  - Features known before the council answers only (never the decision's stance, bias, confidence or
    plan), present in at least 20 % of the rows; a missing value stays missing (LightGBM's own handling).
  - Walk-forward check: trained on the oldest 70 % of the decisive rows, judged on the newest 30 %
    (Brier score against the base rate, AUC, the mean R of the rows it would pick); then trained on all.
  - The trees are written as compact JSON that the AI Worker evaluates itself (src/model-gbm.mjs); the
    script checks that its own evaluation of that JSON equals LightGBM's on every row before it writes.

The repository is public (RFC section 2): this script prints aggregate scores only, never a row, a
feature value or a tree. Deterministic: fixed seeds, LightGBM's deterministic mode.
"""
import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone

import lightgbm as lgb
import numpy as np

VERSION = "cryptophys.model-gbm.v1"
DECISION_OUTPUTS = re.compile(r"^(stance|bias|confidence|plan_)")
LABEL_SETS = ("tight", "wide")
SIDES = ("long", "short")
RULES = {"min_rows": 150, "min_test": 40, "train_share": 0.7, "feature_presence": 0.2}
PARAMS = {
    "objective": "binary", "num_leaves": 7, "learning_rate": 0.05, "min_data_in_leaf": 20,
    "feature_fraction": 0.8, "bagging_fraction": 0.8, "bagging_freq": 1, "lambda_l2": 1.0,
    "seed": 7, "deterministic": True, "force_row_wise": True, "num_threads": 1, "verbose": -1,
}
ROUNDS = 150
MISSING = {"None": 0, "Zero": 1, "NaN": 2}


def num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def label(row, label_set, side):
    """(y, r) of a decisive row for one label set and side, or None."""
    if label_set == "tight":
        outcome, r = row.get(f"{side}_outcome"), row.get(f"{side}_r")
    else:
        lab = ((row.get("wide") or {}).get(side)) or {}
        outcome, r = lab.get("outcome"), lab.get("r")
    if outcome not in ("target", "stop"):
        return None
    y = 1 if outcome == "target" else 0
    return y, (r if num(r) else (1.5 if y else -1.0))


def select_features(rows):
    count = {}
    for row in rows:
        for k, v in (row.get("features") or {}).items():
            if num(v) and not DECISION_OUTPUTS.match(k):
                count[k] = count.get(k, 0) + 1
    keys = sorted(k for k, n in count.items() if n >= RULES["feature_presence"] * len(rows))
    out = []
    for k in keys:
        vals = {row["features"][k] for row in rows if num((row.get("features") or {}).get(k))}
        if len(vals) > 1:
            out.append(k)
    return out


def matrix(rows, features):
    return np.array([[float(row["features"][k]) if num((row.get("features") or {}).get(k)) else np.nan for k in features] for row in rows], dtype=np.float64)


def compact(node):
    """LightGBM's dumped tree as nested lists: a leaf is its value, a split [feature, threshold, default_left, missing, left, right]."""
    if "leaf_value" in node:
        return node["leaf_value"]
    if node.get("decision_type") != "<=":
        raise ValueError("only numerical splits are expected")
    return [node["split_feature"], node["threshold"], 1 if node["default_left"] else 0, MISSING[node["missing_type"]], compact(node["left_child"]), compact(node["right_child"])]


def walk(node, x):
    """The Worker's evaluation of one compact tree (src/model-gbm.mjs), mirrored to check the export."""
    while isinstance(node, list):
        f, t, default_left, missing, left, right = node
        v = x[f]
        if math.isnan(v) and missing != 2:
            v = 0.0
        if (missing == 1 and v == 0.0) or (missing == 2 and math.isnan(v)):
            node = left if default_left else right
        else:
            node = left if v <= t else right
    return node


def raw_score(trees, x):
    return sum(walk(t, x) for t in trees)


def sigmoid(z):
    return 1 / (1 + math.exp(-z)) if z >= 0 else math.exp(z) / (1 + math.exp(z))


def auc(ps, ys):
    pos = [p for p, y in zip(ps, ys) if y]
    neg = [p for p, y in zip(ps, ys) if not y]
    if not pos or not neg:
        return None
    s = sum(1.0 if a > b else 0.5 if a == b else 0.0 for a in pos for b in neg)
    return round(s / (len(pos) * len(neg)), 4)


def fit(x, y):
    return lgb.train(PARAMS, lgb.Dataset(x, label=y, free_raw_data=False), num_boost_round=ROUNDS)


def judge(booster, x, y, r, base):
    ps = booster.predict(x)
    brier = float(np.mean((ps - y) ** 2))
    brier_base = float(np.mean((base - y) ** 2))
    picked = ps >= 0.5
    return {
        "n": int(len(y)), "hit_rate": round(float(np.mean(y)), 4), "brier": round(brier, 4), "brier_base": round(brier_base, 4),
        "skill": round(1 - brier / brier_base, 4) if brier_base > 0 else None, "auc": auc(list(ps), list(y)),
        "picked": int(picked.sum()), "picked_mean_r": round(float(np.mean(r[picked])), 4) if picked.any() else None,
        "all_mean_r": round(float(np.mean(r)), 4),
    }


def train(rows, now):
    rows = sorted(rows, key=lambda row: row.get("bar_close") or "")
    features = select_features(rows)
    models, checks = {}, {}
    for label_set in LABEL_SETS:
        for side in SIDES:
            mid = f"{label_set}_{side}"
            data = [(row, lab) for row in rows if (lab := label(row, label_set, side))]
            cut = int(len(data) * RULES["train_share"])
            if len(data) < RULES["min_rows"] or len(data) - cut < RULES["min_test"] or not features:
                checks[mid] = {"status": "not_enough_rows", "rows": len(data), "needed": RULES["min_rows"]}
                continue
            x = matrix([row for row, _ in data], features)
            y = np.array([lab[0] for _, lab in data], dtype=np.float64)
            r = np.array([lab[1] for _, lab in data], dtype=np.float64)
            base_train = float(np.clip(np.mean(y[:cut]), 0.01, 0.99))
            check = judge(fit(x[:cut], y[:cut]), x[cut:], y[cut:], r[cut:], base_train)
            checks[mid] = {"status": "ok", "train": cut, **check}
            booster = fit(x, y)
            trees = [compact(t["tree_structure"]) for t in booster.dump_model()["tree_info"]]
            # The export must score exactly as LightGBM does, or nothing is written.
            ours = np.array([sigmoid(raw_score(trees, row)) for row in x])
            if not np.allclose(ours, booster.predict(x), atol=1e-9):
                raise SystemExit(f"{mid}: the compact trees do not reproduce LightGBM's predictions")
            gain = booster.feature_importance(importance_type="gain")
            top = sorted(((features[i], round(float(g), 3)) for i, g in enumerate(gain) if g > 0), key=lambda t: -t[1])[:12]
            models[mid] = {"base_rate": round(float(np.clip(np.mean(y), 0.01, 0.99)), 4), "n": int(len(y)), "trees": trees, "top_features": [{"feature": f, "gain": g} for f, g in top]}
    return {
        "version": VERSION, "model_id": f"gbm@{now.strftime('%Y-%m-%dT%H:%M')}Z", "trained_at": now.isoformat().replace("+00:00", "Z"),
        "rows": len(rows), "features": features, "params": {**PARAMS, "rounds": ROUNDS}, "rules": RULES,
        "models": models, "checks": checks, "status": "ok" if models else "not_enough_rows",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()
    with open(args.input, encoding="utf-8") as fh:
        rows = json.load(fh)
    model = train(rows, datetime.now(timezone.utc))
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(model, fh, separators=(",", ":"))
    # Aggregate scores only (a public log).
    print(json.dumps({"model_id": model["model_id"], "rows": model["rows"], "features": len(model["features"]), "status": model["status"],
                      "checks": {k: {kk: v.get(kk) for kk in ("status", "n", "skill", "auc", "picked", "picked_mean_r", "all_mean_r")} for k, v in model["checks"].items()}}))
    return 0 if model["status"] == "ok" else 3


if __name__ == "__main__":
    sys.exit(main())
