ARG BASE_IMAGE=nvcr.io/nvidia/pytorch:25.04-py3
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/opt/rapptor-prediction/src \
    RAPPTOR_MODEL_DIR=/models \
    RAPPTOR_DATA_ROOT=/data

WORKDIR /opt/rapptor-prediction
COPY services/prediction/requirements.txt /tmp/rapptor-prediction-requirements.txt
RUN python -m pip install --no-cache-dir -r /tmp/rapptor-prediction-requirements.txt \
    && useradd --create-home --uid 10001 rapptor \
    && mkdir -p /data/jobs \
    && chown -R rapptor:rapptor /data
COPY --chown=rapptor:rapptor services/prediction/src ./src

USER rapptor
EXPOSE 8000
CMD ["python", "-m", "prediction_service"]
