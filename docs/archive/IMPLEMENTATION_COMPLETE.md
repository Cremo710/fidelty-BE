# ✅ Frontend-Backend Alignment - Bar Registration Complete

## 🎯 Problema Risolto

I nomi dei campi tra frontend e backend non erano allineati:
- **Frontend inviava:** `piva`, `barName`, `businessName`, `address`, `coverImage` (FILE)
- **Backend si aspettava:** `iva`, `merchantName`, `name`, `address`, `image` (URL string)

**Soluzione:** Backend completamente riallineato al frontend

---

## 📋 Modifiche Implementate

### ✅ Backend (Back-end)

#### 1. `src/validators/barValidator.ts`
- Nomi campi allineati: `piva`, `barName`, `businessName`, `address`
- Validazione P.IVA: regex `^\d{11}$` (esattamente 11 cifre)
- Compatibile con FormData del frontend

#### 2. `src/utils/imageUpload.ts` (NUOVO FILE)
```typescript
// Funzioni disponibili:
- saveAndOptimizeImage(buffer, filename) → URL
- isPngFile(mimeType) → boolean
- isFileSizeValid(fileSize, maxMB) → boolean
```
- Salva in `/uploads/bars/`
- Ottimizza con sharp (1200px max, quality 80)
- Ritorna URL: `/uploads/bars/{timestamp}-{filename}`

#### 3. `src/controllers/barController.ts`
- Parser multipart form-data aggiunto
- Gestione file PNG con validazione
- Mappatura dei nomi dal database al response
- Response con **esattamente i nomi del frontend:**
  ```json
  {
    "id": number,
    "piva": string,
    "barName": string,
    "businessName": string,
    "address": string,
    "coverImage": string (URL)
  }
  ```

#### 4. `src/repositories/barRepository.ts`
- Parametri allineati: `piva` instead of `iva`
- Metodo `pivaExists()` aggiunto
- Colonne database rimangono: iva, merchant_name, name, image

#### 5. `package.json`
- Aggiunto: `"@fastify/static": "^7.0.0"`

#### 6. `src/index.ts`
- Importi aggiornati per path resolution
- Plugin @fastify/static registrato
- Static serving da `/uploads` directory

#### 7. `.gitignore`
- Aggiunto: `uploads/` directory

### ✅ Frontend (Front-end)

#### `src/services/apiService.js`
- **FIXED:** Content-Type header in `registerBar()`
  - Removed manual `'Content-Type': 'multipart/form-data'`
  - FormData handled automatically by browser
  - Keep only `Authorization: Bearer` header

---

## 🔄 Data Flow (Aligned)

### POST /api/bar/registration

**Frontend:**
```javascript
const formData = new FormData();
formData.append('piva', '12345678901');          // STRING
formData.append('barName', 'Bar Milano');        // STRING
formData.append('businessName', 'S.R.L.');       // STRING
formData.append('address', 'Via Roma 1');        // STRING
formData.append('coverImage', {                  // FILE OBJECT
  uri: '/path/to/image.png',
  type: 'image/png',
  name: 'filename.png',
});

fetch('/api/bar/registration', {
  method: 'POST',
  headers: { Authorization: 'Bearer token' },
  body: formData,
});
```

**Backend Process:**
```
1. Parse multipart form-data
   ├─ Extract text fields: piva, barName, businessName, address
   └─ Extract file: coverImage

2. Validate
   ├─ File: PNG, max 5MB
   ├─ Fields: P.IVA = 11 digits
   ├─ P.IVA not duplicate
   └─ User has no bar yet

3. Process Image
   ├─ Optimize with sharp
   ├─ Save to /uploads/bars/
   └─ Get URL: /uploads/bars/{timestamp}-{filename}

4. Save to Database
   ├─ Map piva → iva column
   ├─ Map barName → name column
   ├─ Map businessName → merchant_name column
   └─ Map coverImage URL → image column

5. Return Response
   └─ Map back to frontend field names
```

**Response:**
```json
{
  "success": true,
  "message": "Bar registrato con successo",
  "data": {
    "id": 123,
    "userId": 456,
    "piva": "12345678901",
    "barName": "Bar Milano",
    "businessName": "S.R.L.",
    "address": "Via Roma 1, Milano",
    "coverImage": "/uploads/bars/1708018200000-bar_cover_1707941234.png"
  }
}
```

### GET /api/bar/profile

**Request:**
```javascript
fetch('/api/bar/profile', {
  method: 'GET',
  headers: { Authorization: 'Bearer token' },
});
```

**Backend Process:**
```
1. Extract userId from token
2. Query: SELECT * FROM bars WHERE user_id = ?
3. Map database field names → frontend names
   ├─ iva → piva
   ├─ merchant_name → businessName
   ├─ name → barName
   ├─ address → address
   └─ image → coverImage
4. Return with timestamps
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "piva": "12345678901",
    "barName": "Bar Milano",
    "businessName": "S.R.L.",
    "address": "Via Roma 1, Milano",
    "coverImage": "/uploads/bars/1708018200000-bar_cover_1707941234.png",
    "createdAt": "2025-02-14T10:30:00Z",
    "updatedAt": "2025-02-14T10:30:00Z"
  }
}
```

---

## 🚀 Setup Instructions

### 1. Backend - Install Dependencies
```bash
cd back-end
npm install
# Installa @fastify/static e eventuali altre dipendenze mancanti
```

### 2. Backend - Build & Run
```bash
npm run dev
# or
npm run build && npm start
```

Output expected:
```
✅ Connessione al database OK
✅ Database inizializzato
📁 Static files served from: /path/to/uploads
✨ Server pronto!
🌐 http://0.0.0.0:4000
```

### 3. Frontend - No Changes Needed
Frontend dovrebbe funzionare as-is con le modifiche apportate

---

## ✅ Testing Checklist

### FE → BE Communication
- [ ] Frontend invia POST /api/bar/registration con multipart/form-data
- [ ] Backend riceve correttamente piva, barName, businessName, address, coverImage
- [ ] File PNG viene validato (type, size)
- [ ] Image viene salvata in /uploads/bars/
- [ ] Response contiene URL dell'immagine
- [ ] Response contiene nomi esatti: piva, barName, businessName, address, coverImage

### Data Mapping
- [ ] Database column `iva` ← frontend field `piva` ✓
- [ ] Database column `name` ← frontend field `barName` ✓
- [ ] Database column `merchant_name` ← frontend field `businessName` ✓
- [ ] Database column `address` ← frontend field `address` ✓
- [ ] Database column `image` ← uploaded file URL ✓

### GET Bar Profile
- [ ] Frontend GET /api/bar/profile
- [ ] Backend returns all fields with frontend names
- [ ] Response includes coverImage as URL
- [ ] HomeScreen displays barName, businessName, address, coverImage
- [ ] BarProfileScreen displays all details correctly

### Error Cases
- [ ] Duplicate P.IVA → 409 Conflict
- [ ] Missing field → 400 Bad Request
- [ ] Invalid P.IVA format → 400 Bad Request
- [ ] Non-PNG file → 400 Bad Request
- [ ] File > 5MB → 400 Bad Request
- [ ] User already has bar → 409 Conflict
- [ ] Invalid token → 401 Unauthorized

---

## 📁 Files Modified

```
BACKEND
├── src/
│   ├── validators/barValidator.ts                    ✅ MODIFIED
│   ├── utils/imageUpload.ts                          ✅ CREATED
│   ├── controllers/barController.ts                  ✅ MODIFIED
│   ├── repositories/barRepository.ts                 ✅ MODIFIED
│   └── index.ts                                      ✅ MODIFIED
├── package.json                                      ✅ MODIFIED
├── .gitignore                                        ✅ MODIFIED
└── BAR_REGISTRATION_ALIGNMENT.md                     ✅ CREATED

FRONTEND
└── src/services/apiService.js                        ✅ MODIFIED
```

---

## 🔧 Troubleshooting

### "Module @fastify/static not found"
```bash
cd back-end
npm install @fastify/static
```

### "File not found in /uploads"
- Ensure /uploads directory is created
- Check permissions on /uploads directory
- Verify image was saved (check logs)

### "Bearer token not extracted"
- Ensure `Authorization` header is present
- Format must be: `Authorization: Bearer <token>`
- Frontend header fix should resolve this

### "Content-Type: multipart/form-data" error
- ✅ FIXED in frontend apiService.js
- Don't manually set Content-Type with FormData
- Let the client calculate it automatically

---

## 📚 Documentation Files

Created:
- `BAR_REGISTRATION_ALIGNMENT.md` - Complete technical details
- `BACKEND_BAR_REGISTRATION.md` - Original spec (for reference)
- `BAR_REGISTRATION_SYSTEM.md` - Frontend system (unchanged)

---

## ✨ Summary

**Frontend ↔ Backend Communication:** ✅ ALIGNED  
**Data Field Mapping:** ✅ PERFECT  
**File Upload Handling:** ✅ IMPLEMENTED  
**Image Optimization:** ✅ SHARP CONFIGURED  
**Static File Serving:** ✅ FASTIFY STATIC READY  
**Error Handling:** ✅ COMPLETE  

**Status:** 🟢 READY FOR TESTING
