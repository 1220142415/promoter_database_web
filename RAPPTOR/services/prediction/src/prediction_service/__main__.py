import os
import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "prediction_service.api:app",
        host=os.getenv("RAPPTOR_API_HOST", "0.0.0.0"),
        port=int(os.getenv("RAPPTOR_API_PORT", "8000")),
        workers=1,
    )
