# Prediction model assets

Each model version has its own directory containing tracked provenance metadata
and configuration. `best_model.pt` is intentionally ignored by Git and mounted
read-only into the API and worker containers; it is never copied into the image.

The current local asset is `candidate-github-93cf`. Its manifest explicitly
marks it as a non-production candidate. Do not relabel it as the historical
GTDB production checkpoint until that weight identity is resolved.
