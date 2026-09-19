SHELL := /bin/bash

.PHONY: up down clean logs ps migrate seed build typecheck psql

.env:
	cp .env.example .env

up: .env
	docker compose up -d --build --wait

down:
	docker compose down

clean:
	docker compose down -v --remove-orphans

logs:
	docker compose logs -f

ps:
	docker compose ps

migrate: .env
	docker compose run --rm --build tools node dist/scripts/migrate.js

seed: migrate
	docker compose run --rm tools node dist/scripts/seed.js

psql: .env
	docker compose exec postgres sh -c 'psql -U "$$POSTGRES_USER" -d "$$POSTGRES_DB"'

build:
	npm run build

typecheck:
	npm run typecheck
