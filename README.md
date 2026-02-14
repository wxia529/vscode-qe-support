# QE Support

VS Code support for Quantum ESPRESSO input files. Provides syntax highlighting, completions, hover docs, and diagnostics for common PWscf inputs.

## Features

- Syntax highlighting for QE input files (`.in`, `.pwi`, `.pw`).
- Section, variable, and option completions.
- Hover docs with descriptions, defaults, ranges, and units.
- Diagnostics for invalid options and range violations.
- Snippets for common namelists and cards.

## Usage

1. Open a QE input file (extension `.in`, `.pwi`, `.pw`) or set the language to `QE Input`.
2. Type `&` to insert namelist sections.
3. Type a variable name and `=` to see value completions.
4. Type a card name (e.g. `ATOMIC_POSITIONS`) and a space to see card option completions.

## Data Sources

The completion and diagnostic data are derived from the Quantum ESPRESSO input documentation and curated for common workflows. Source parser and intermediate scripts live in `parse_qe_to_json/`.

## Known Issues

- Some variables/options may be missing or overly strict; please report issues with example inputs.
- Card option validation is limited to documented options and does not interpret complex expressions.

## Contributing

Issues and PRs are welcome. Please include a minimal QE input example when reporting data errors.
