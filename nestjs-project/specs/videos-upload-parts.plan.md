---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.10
target_file: test/videos-upload-parts.e2e-spec.ts
---

# GET /videos/:id/upload/parts — Test Plan

## Application Overview

`GET /videos/:id/upload/parts` lista as partes já gravadas no multipart aberto (`ListParts` paginado até o fim), ordenadas por `part_number`, com `etag` e `size_bytes`, para que o cliente retome um upload interrompido enviando só o que falta. Só o dono do vídeo acessa, e o vídeo precisa estar em `pending_upload`.

## Test Scenarios

### 1. GET /videos/:id/upload/parts

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com canal (dono e outro), faz login de ambos e cria via `POST /videos` um vídeo de 3 partes do dono; RustFS e Redis reais da rede Compose, com `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no ambiente de teste para que as URLs assinadas saiam com o host que o container alcança (a assinatura SigV4 inclui o host, então ele não pode ser reescrito depois); `afterAll(() => app.close())`.

#### 1.1. lista-partes-enviadas-com-etag

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Pedir URLs das partes 1 e 2 via `POST /videos/:id/upload/part-urls` e enviar poucos KB em cada uma por PUT (o storage só exige o mínimo de 5 MiB por parte na conclusão, não na listagem), guardando os `ETag` devolvidos
  2. GET /videos/:id/upload/parts com o token do dono
    - expect: status `200`
    - expect: `parts` com exatamente 2 itens, `part_number` 1 e 2 nessa ordem
    - expect: cada `etag` igual ao `ETag` devolvido no PUT correspondente e `size_bytes` igual ao tamanho enviado

#### 1.2. video-sem-partes-devolve-lista-vazia

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:id/upload/parts com o token do dono para o vídeo recém-criado
    - expect: status `200`
    - expect: body `{ parts: [] }`

#### 1.3. outro-usuario-recebe-not-found

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:id/upload/parts com o token do outro usuário
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`

#### 1.4. rejeita-video-fora-de-pending-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. Atualizar no banco o `processing_status` do vídeo para `processing`
  2. GET /videos/:id/upload/parts com o token do dono
    - expect: status `409`
    - expect: body `error: "VIDEO_UPLOAD_NOT_PENDING"`
