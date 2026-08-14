CREATE INDEX IF NOT EXISTS facet_options_search_value
  ON facet_options(
    release_id,
    value COLLATE NOCASE,
    kind,
    domain,
    phylum,
    class_name,
    order_name,
    family
  );
