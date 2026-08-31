# Inference runtime provenance

The minimal inference runtime under `src/rapptor` was copied from
`duolaJohn/RAPPtor` at commit
`0b44bf9a6f31d12638743197c4cc480104f75209` and reduced to the model,
configuration, CGR conversion, and sliding-window inference modules required by
the queued service. Training, analysis, plotting, CLI, and activity-fine-tuning
modules are intentionally excluded.

`src/prediction_service` originated from the local
`feat/docker-prediction-service` implementation at commit `00e62c1` and is now
owned by this web repository. Future service changes should be made here to
avoid two diverging deployment implementations.
