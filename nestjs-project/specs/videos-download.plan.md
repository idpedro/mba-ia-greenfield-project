---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.17
target_file: test/videos-download.e2e-spec.ts
---

# GET /videos/:slug/download — Test Plan

## Application Overview

`GET /videos/:slug/download` segue as mesmas regras do streaming (dono, `ready`, `302` com `Cache-Control: no-store`), mas a URL assinada carrega `response-content-disposition` = `attachment; filename="{nome ASCII seguro}"; filename*=UTF-8''{nome RFC 5987}` a partir de `original_filename`, forçando o navegador a salvar o arquivo com o nome original.

## Test Scenarios

### 1. GET /videos/:slug/download

**Setup:** `beforeAll` sobe `Test.createTestingModule({ imports: [AppModule] }).compile()` reproduzindo a config global de `main.ts` (`ValidationPipe` + `DomainExceptionFilter` + `ValidationExceptionFilter`); `beforeEach` roda `cleanAllTables(dataSource)`, cria dois usuários confirmados com canal (dono e outro), faz login de ambos e semeia no canal do dono vídeos `ready` com objeto real no RustFS — um com `original_filename: "aula.mp4"` e outro com `original_filename: "aula 1 — introdução.mp4"` — além de um vídeo em `processing`; RustFS e Redis reais da rede Compose, com `S3_PUBLIC_ENDPOINT=http://rustfs:9000` no ambiente de teste para que as URLs assinadas saiam com o host que o container alcança (a assinatura SigV4 inclui o host, então ele não pode ser reescrito depois); `afterAll(() => app.close())`.

#### 1.1. redireciona-com-content-disposition-attachment

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/download com o token do dono para o vídeo `aula.mp4`, sem seguir redirects
    - expect: status `302` com header `Location` e `Cache-Control: no-store`
  2. GET na `Location`, sem alterar a URL
    - expect: status `200`
    - expect: header `Content-Disposition` começando com `attachment` e contendo `aula.mp4`

#### 1.2. nome-com-acentos-usa-filename-estrela-utf8

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/download com o token do dono para o vídeo `aula 1 — introdução.mp4` e GET na `Location` devolvida
    - expect: status `200`
    - expect: `Content-Disposition` contém `filename*=UTF-8''` seguido do nome codificado em RFC 5987 (`aula%201%20%E2%80%94%20introdu%C3%A7%C3%A3o.mp4`)

#### 1.3. video-nao-ready-retorna-conflito

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/download com o token do dono para o vídeo em `processing`
    - expect: status `409`
    - expect: body `error: "VIDEO_NOT_READY"`

#### 1.4. outro-usuario-recebe-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-10-30T06:51:57Z

**Steps:**
  1. GET /videos/:slug/download com o token do outro usuário para o vídeo `aula.mp4` do dono
    - expect: status `404`
    - expect: body `error: "VIDEO_NOT_FOUND"`
