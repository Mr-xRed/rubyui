FROM python:3.12-slim

WORKDIR /app

# Copy only requirements first — Docker caches this layer.
# pip install only re-runs when requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && pip uninstall -y pydub 
# magika onnxruntime

# The rest of /app is bind-mounted at runtime, so no COPY needed for server.py.
# This image only needs to bake in the dependencies.

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
