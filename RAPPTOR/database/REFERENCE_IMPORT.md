# Reference import contract

RAPPTOR keeps `genomes.accession` as its stable public identifier and URL key. Each imported reference also records its identifier namespace, source accession and provenance in `reference_namespace`, `reference_accession` and `reference_provenance_json`.

Predictions, annotations, experimental promoters and TSS datasets remain separate `feature_sets` linked by `(release_id, accession)`. Every independently selectable publication or assay gets its own `feature_definitions.definition_id`; DOI/PMID, assay, condition, coordinate convention and processing details belong in `provenance_json` or `configuration_json`.

Experimental coordinates must target the exact imported reference. If a paper used another strain or assembly, import that reference separately instead of attaching coordinates to the nearest GTDB genome.

Promoter-only sequences without a complete reference genome are outside the current catalog contract and need a separate reference-record type before import.
