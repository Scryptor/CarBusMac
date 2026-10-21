# Сборка фронта (Vite) → статика, затем бэкенд на Python 3.12 отдаёт её и WS.
FROM node:22-alpine AS frontend
WORKDIR /fe
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
WORKDIR /app/backend
COPY backend/ /app/backend/
# версии зависимостей закреплены (backend/constraints.txt) — сборка воспроизводима
RUN pip install --no-cache-dir -c constraints.txt .
COPY --from=frontend /fe/dist /app/frontend/dist
EXPOSE 8000
# `python -m` кладёт cwd (/app/backend) в sys.path → импортируется локальный пакет app,
# а server.py видит /app/frontend/dist и /app/traces по относительным путям.
CMD ["python", "-m", "uvicorn", "app.server:app", "--host", "0.0.0.0", "--port", "8000"]
