from bs4 import BeautifulSoup
import json
import re

# ================= 配置区域 =================
HTML_FILE = "input_pw.raw.html"
# ===========================================

def _normalize_text(text):
    return re.sub(r"\s+", " ", text or "").strip()

def _map_type(type_text, name):
    normalized = (type_text or "").upper().strip()
    base = None
    if "CHARACTER" in normalized:
        base = "String"
    elif "INTEGER" in normalized:
        base = "Integer"
    elif "REAL" in normalized:
        base = "Real"
    elif "LOGICAL" in normalized:
        base = "Logical"
    if not base:
        return None
    if "(" in (name or "") or ")" in (name or ""):
        return "Array"
    return base

def _extract_default(table):
    for tr in table.find_all("tr"):
        i_tag = tr.find("i")
        if i_tag and "Default" in i_tag.get_text():
            tds = tr.find_all("td")
            if len(tds) >= 2:
                return _normalize_text(tds[1].get_text(" ", strip=True))
    return None

def _extract_description(table):
    pres = table.find_all("pre")
    if not pres:
        return None
    parts = [_normalize_text(pre.get_text(" ", strip=True)) for pre in pres]
    return _normalize_text(" ".join(p for p in parts if p))

def _extract_units(description):
    if not description:
        return None
    candidates = []
    paren = re.search(r"\(([^\)]+)\)", description)
    if paren:
        candidates.append(_normalize_text(paren.group(1)))
    for m in re.finditer(r"\bin\s+([A-Za-z/\^0-9\-\*\.]+)\b", description):
        candidates.append(_normalize_text(m.group(1)))
    for m in re.finditer(r"units? of\s+([A-Za-z/\^0-9\-\*\.]+)", description, re.IGNORECASE):
        candidates.append(_normalize_text(m.group(1)))
    for candidate in candidates:
        unit = _normalize_unit(candidate)
        if unit:
            return unit
    return None

def _normalize_unit(text):
    if not text:
        return None
    lowered = text.lower().strip(".")
    unit_map = {
        "ry": "Ry",
        "rydberg": "Ry",
        "ev": "eV",
        "bohr": "bohr",
        "angstrom": "angstrom",
        "a.u": "a.u.",
        "au": "a.u.",
        "amu": "amu",
        "kcal/mol": "kcal/mol",
        "kelvin": "K",
        "k": "K",
        "fs": "fs",
        "cm": "cm",
        "nm": "nm",
        "pm": "pm",
        "ha": "Ha",
        "hartree": "Ha",
        "1/bohr^3": "1/bohr^3",
        "ry/a.u": "Ry/a.u.",
        "ry/a.u.": "Ry/a.u.",
        "a.u./ry": "a.u./Ry"
    }
    if lowered in unit_map:
        return unit_map[lowered]
    if re.fullmatch(r"1/bohr\^3", lowered):
        return "1/bohr^3"
    if re.fullmatch(r"[A-Za-z/\^0-9\-\.]+", text) and len(text) <= 12:
        return text
    return None

def _extract_range(description):
    if not description:
        return None
    m = re.search(r"(-?\d+(?:\.\d+)?)\s*<\s*\w+\s*<\s*(-?\d+(?:\.\d+)?)", description)
    if m:
        return f"{m.group(1)} < x < {m.group(2)}"
    m = re.search(r"\b(in|within)\s*\]\s*([\-\d\.]+)\s*,\s*([\-\d\.]+)\s*\[", description)
    if m:
        return f"{m.group(2)}..{m.group(3)}"
    m = re.search(r"between\s+(-?\d+(?:\.\d+)?)\s+and\s+(-?\d+(?:\.\d+)?)", description, re.IGNORECASE)
    if m:
        return f"{m.group(1)}..{m.group(2)}"
    m = re.search(r"from\s+(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?)", description, re.IGNORECASE)
    if m:
        return f"{m.group(1)}..{m.group(2)}"
    return None

def _extract_constraints(description):
    if not description:
        return None
    raw_conditions = []
    for pat in [r"only if ([^\.;]+)", r"only when ([^\.;]+)", r"used only when ([^\.;]+)", r"if ([^\.;]+)"]:
        for m in re.finditer(pat, description, re.IGNORECASE):
            raw_conditions.append(_normalize_text(m.group(1)))
    normalized = []
    for cond in raw_conditions:
        parsed = _normalize_condition(cond)
        if parsed:
            normalized.append(parsed)
    if not normalized:
        return None
    deduped = []
    seen = set()
    for item in normalized:
        if item not in seen:
            seen.add(item)
            deduped.append(item)
    return {"requires": [], "conflicts": [], "implies": [], "validWhen": deduped}

def _normalize_condition(text):
    if not text:
        return None
    t = _normalize_text(text)
    t = re.sub(r"\s+", " ", t)
    m = re.search(r"([A-Za-z_][A-Za-z0-9_\(\)]+)\s*(==|=|/=|>=|<=|>|<)\s*([A-Za-z0-9_\.\-']+)", t)
    if m:
        left = m.group(1)
        op = m.group(2)
        right = m.group(3)
        return f"{left} {op} {right}"
    m = re.search(r"\b([A-Za-z_][A-Za-z0-9_\(\)]+)\s+is\s+(\.TRUE\.|\.FALSE\.|true|false)\b", t, re.IGNORECASE)
    if m:
        return f"{m.group(1)} == {m.group(2).upper()}"
    m = re.search(r"\b([A-Za-z_][A-Za-z0-9_\(\)]+)\s+set\b", t, re.IGNORECASE)
    if m:
        return f"{m.group(1)} == .TRUE."
    return None

def _extract_options(table, description):
    options = []
    seen = set()
    for span in table.find_all("span", class_="flag"):
        val = _normalize_text(span.get_text(" ", strip=True))
        if val and val not in seen:
            seen.add(val)
            options.append(val)
    if description:
        for val in re.findall(r"'[^']+'", description):
            if val not in seen:
                seen.add(val)
                options.append(val)
    return options

def _is_variable_table(table):
    rows = table.find_all("tr", recursive=False)
    if not rows:
        return False
    first_row = rows[0]
    th = first_row.find("th")
    tds = first_row.find_all("td")
    if not th or not tds:
        return False
    name_text = _normalize_text(th.get_text(" ", strip=True))
    if not name_text or "Card's options" in name_text:
        return False
    type_text = _normalize_text(tds[0].get_text(" ", strip=True))
    return type_text.upper() in {"CHARACTER", "INTEGER", "REAL", "LOGICAL"}

def _parse_variable_table(table, section_title, section_type):
    if not _is_variable_table(table):
        return None
    first_row = table.find_all("tr", recursive=False)[0]
    name = _normalize_text(first_row.find("th").get_text(" ", strip=True))
    type_text = _normalize_text(first_row.find_all("td")[0].get_text(" ", strip=True))
    mapped_type = _map_type(type_text, name)
    if not mapped_type:
        return None
    default = _extract_default(table)
    description = _extract_description(table)
    options = _extract_options(table, description)
    units = _extract_units(description)
    value_range = _extract_range(description)
    constraints = _extract_constraints(description)
    return {
        "name": name,
        "section": section_title,
        "sectionType": section_type,
        "type": mapped_type,
        "default": default,
        "description": description,
        "options": options,
        "units": units,
        "range": value_range,
        "example": None,
        "since": None,
        "notes": None,
        "constraints": constraints,
        "rawText": description
    }

def _extract_card_options(section_table):
    for table in section_table.find_all("table"):
        th = table.find("th")
        if not th:
            continue
        if "Card's options" not in th.get_text():
            continue
        options = []
        seen = set()
        for span in table.find_all("span", class_="flag"):
            val = _normalize_text(span.get_text(" ", strip=True))
            if val and val not in seen:
                seen.add(val)
                options.append(val)
        default = _extract_default(table)
        return {"options": options, "default": default}
    return None

def get_sections():
    """
    解析 Namelist 和 Card 章节
    """
    print(f"正在读取 {HTML_FILE} ...")
    with open(HTML_FILE, "r", encoding="utf-8") as f:
        html_content = f.read()
    soup = BeautifulSoup(html_content, 'html.parser')
    sections = []
    for h2 in soup.find_all('h2'):
        header_text = h2.get_text(" ", strip=True)
        if "Namelist:" in header_text:
            section_type = "namelist"
            name_node = h2.find("span", class_="namelist")
        elif "Card:" in header_text:
            section_type = "card"
            name_node = h2.find("span", class_="card")
        else:
            continue

        title = _normalize_text(name_node.get_text(" ", strip=True) if name_node else header_text)
        section_table = h2.find_parent("table")
        if not section_table:
            continue
        sections.append({
            "title": title,
            "section_type": section_type,
            "table": section_table
        })
    return sections

def main():
    sections = get_sections()
    print(f"找到 {len(sections)} 个章节，开始解析...")

    completion_data = {
        "sections": {}
    }
    diagnostics_data = {
        "variables": {},
        "cards": {}
    }
    constraints_data = {
        "variables": {}
    }
    ranges_data = {
        "variables": {}
    }
    snippets_data = {}

    for section in sections:
        title = section["title"]
        section_type = section["section_type"]
        section_table = section["table"]

        variables = {}
        for table in section_table.find_all("table"):
            var_info = _parse_variable_table(table, title, section_type)
            if not var_info:
                continue
            variables[var_info["name"]] = var_info

        section_entry = {
            "sectionType": section_type,
            "variables": variables
        }
        if section_type == "card":
            card_opts = _extract_card_options(section_table)
            if card_opts:
                section_entry["cardOptions"] = card_opts
                diagnostics_data["cards"][title] = card_opts

        completion_data["sections"][title] = section_entry

        snippet_prefix = title
        if section_type == "namelist":
            snippet_body = [
                f"&{title}",
                "  ${1:var} = ${2:value}",
                "/"
            ]
        else:
            card_opts = section_entry.get("cardOptions", {})
            opt_hint = ""
            if card_opts.get("options"):
                opt_hint = " { " + " | ".join(card_opts["options"]) + " }"
            snippet_body = [
                f"{title}{opt_hint}",
                "${1:...}"
            ]
        snippets_data[title] = {
            "prefix": snippet_prefix,
            "body": snippet_body,
            "description": f"{section_type} {title}"
        }

        for var_name, var_info in variables.items():
            diagnostics_data["variables"][f"{title}.{var_name}"] = {
                "type": var_info.get("type"),
                "options": var_info.get("options", []),
                "default": var_info.get("default"),
                "range": var_info.get("range"),
                "units": var_info.get("units"),
                "section": title
            }
            if var_info.get("constraints"):
                constraints_data["variables"][f"{title}.{var_name}"] = var_info.get("constraints")
            if var_info.get("range") or var_info.get("units"):
                ranges_data["variables"][f"{title}.{var_name}"] = {
                    "range": var_info.get("range"),
                    "units": var_info.get("units")
                }

    with open("completion.json", "w", encoding="utf-8") as f:
        json.dump(completion_data, f, indent=2, ensure_ascii=False)

    with open("diagnostics.json", "w", encoding="utf-8") as f:
        json.dump(diagnostics_data, f, indent=2, ensure_ascii=False)

    with open("constraints.json", "w", encoding="utf-8") as f:
        json.dump(constraints_data, f, indent=2, ensure_ascii=False)

    with open("ranges.json", "w", encoding="utf-8") as f:
        json.dump(ranges_data, f, indent=2, ensure_ascii=False)

    with open("snippets.json", "w", encoding="utf-8") as f:
        json.dump(snippets_data, f, indent=2, ensure_ascii=False)
    print("完成：已生成 completion.json、diagnostics.json、constraints.json、ranges.json、snippets.json")

if __name__ == "__main__":
    main()