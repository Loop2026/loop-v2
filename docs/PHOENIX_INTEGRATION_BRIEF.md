# Brief integrazione Loop ↔ Gestionale Phoenix

**Da:** Luca Di Gioia (Loop)
**A:** team sviluppo Phoenix Data Analytics
**Data:** 25 aprile 2026
**Oggetto:** richiesta autenticazione server-to-server per `/api/clients`

---

## Cosa stiamo facendo

Stiamo riorganizzando le app Loop (dashboard clienti, console arbitraggio,
future app trading) in modo che ogni dato abbia **una sola fonte di verità**
e non venga duplicato.

I conti broker MT5 hanno già il loro vault dedicato. L'anagrafica clienti
vorremmo invece **leggerla direttamente dal Gestionale Phoenix**, perché lì
è già la più completa e aggiornata.

## Cosa ci serve da Phoenix

Un meccanismo di autenticazione **server-to-server** sui due endpoint:

- `GET /api/clients` (lista completa)
- `GET /api/clients/:id` (singolo cliente)

L'autenticazione attuale via cookie session `GAESA` funziona solo da
browser di un utente loggato — non utilizzabile da un servizio backend.

### Opzione consigliata — API key

La più semplice da implementare:

1. Aggiungere variabile d'ambiente `LOOP_API_KEY` (random 32+ caratteri).
2. Middleware in cima a `/api/clients*` che accetta:
   - cookie `GAESA` valido (comportamento attuale, invariato), **OPPURE**
   - header `X-API-Key: <valore di LOOP_API_KEY>`
3. Comunicarci il valore della chiave in modo sicuro (1Password / messaggio
   cifrato / non email in chiaro).

Se sospetta la chiave, basta ruotarla nell'env e ridare il nuovo valore.

### Permessi minimi richiesti

Solo lettura. Loop non scrive mai sui dati cliente del Gestionale.
Sarebbe ideale che la chiave sia limitata a:

- `GET /api/clients`
- `GET /api/clients/:id`

E **non** abbia accesso a payments, admin, auth, ecc.

## Richiesta opzionale (utile ma non bloccante)

Aggiungere ai documenti cliente un campo per "marcare" quelli con un
abbonamento Loop attivo:

```
loopActive: boolean   (default false)
```

E supportare il filtro nell'API:

```
GET /api/clients?loopActive=true
```

Vantaggi:
- Loop legge solo i clienti che la riguardano (oggi sono ~5 su 22).
- Phoenix può "spegnere" un cliente da Loop senza cancellarlo dal
  Gestionale (basta mettere `loopActive: false`).
- Riduce traffico e dati esposti.

Se preferite mantenere zero modifiche schema, va bene anche senza —
filtreremo lato Loop tramite la lista degli ID che già abbiamo nei
nostri abbonamenti.

## Cosa NON ci serve

- Nessun accesso in scrittura.
- Nessun accesso a payments, fatturazione, contratti.
- Nessun accesso ad admin/auth.
- Nessun webhook (sarebbe nice-to-have, ma fuori scope per ora).

## Schema dati che useremo

Per riferimento, dei campi restituiti dall'endpoint useremo solo:

```
id, nome, cognome, email, telefono,
codiceFiscale, partitaIva,
citta, indirizzo, numeroCivico, cap, paese,
createdAt
```

Tutti già presenti, nessuno schema change richiesto.

## Considerazioni tecniche minori

- **Rate limit**: stimiamo < 50 chiamate/giorno in fase iniziale, < 500/giorno
  a regime. Useremo cache lato Loop (TTL 30s in-memory + fallback 24h).
- **CORS**: non serve. Le chiamate partiranno da edge function Supabase
  (server-side), non da browser.
- **GDPR**: i dati anagrafici restano nella vostra infrastruttura GAE
  (presumibilmente region `europe-west*`). Loop legge solo, non li
  ridistribuisce. Confermateci la region per nostra documentazione.

## Prossimi passi

1. Voi: implementate l'API key (stimo 1-2 ore di lavoro, middleware semplice).
2. Voi: ci fate avere la chiave in modo sicuro.
3. Noi: configuriamo il secret su Loop e implementiamo l'integrazione (stimo
   1 giornata di sviluppo + test).
4. Insieme: smoke test su un cliente reale (es. Mario Filippo De Biase,
   id `8b4bce78-e3a2-4fb6-92d7-37d1ef0d67e2`).

Per qualsiasi domanda tecnica, contattatemi: luca@lucadigioia.ch
