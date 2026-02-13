# 🚀 Quick Reference - Bar Registration (Frontend ↔ Backend)

## ⚡ Field Mapping Cheat Sheet

```
FRONTEND              DATABASE              BACKEND RESPONSE
─────────────────────────────────────────────────────────────
piva          ↔      iva                   piva
barName       ↔      name                  barName
businessName  ↔      merchant_name         businessName
address       ↔      address               address
coverImage*   ↔      image                 coverImage
               
* coverImage: File object → PNG → Save → URL string
```

## 📡 API Endpoints

### POST /api/bar/registration
**Input:** multipart/form-data
```javascript
{
  piva: "12345678901",
  barName: "Bar Milano",
  businessName: "S.R.L.",
  address: "Via Roma 1, Milano",
  coverImage: File (PNG only)
}
```

**Output:** 200 OK
```json
{
  "success": true,
  "data": {
    "id": 123,
    "piva": "12345678901",
    "barName": "Bar Milano",
    "businessName": "S.R.L.",
    "address": "Via Roma 1, Milano",
    "coverImage": "/uploads/bars/..."
  }
}
```

**Errors:**
- 400: Validation failed (bad piva format, missing field, wrong file type)
- 409: Duplicate piva or user already has bar
- 401: Unauthorized (bad token)
- 500: Server error

---

### GET /api/bar/profile
**Input:** Bearer token

**Output:** 200 OK  
```json
{
  "success": true,
  "data": {
    "id": 123,
    "piva": "12345678901",
    "barName": "Bar Milano",
    "businessName": "S.R.L.",
    "address": "Via Roma 1, Milano",
    "coverImage": "/uploads/bars/...",
    "createdAt": "2025-02-14T...",
    "updatedAt": "2025-02-14T..."
  }
}
```

**Errors:**
- 404: Bar not found (user has no bar)
- 401: Unauthorized

---

## 📦 Installation

```bash
# Backend
cd back-end
npm install  # Installs @fastify/static

# Frontend
cd front-end
npm install  # Already done (expo-image-picker added)

# Start backend
cd back-end
npm run dev

# Frontend already runs on Expo
```

---

## ✅ Frontend Checklist

- [x] BarRegistrationScreen - Form with file picker
- [x] BarSuccessScreen - Success confirmation
- [x] BarProfileScreen - Profile view
- [x] HomeScreen - Bar section with register button
- [x] apiService.js - registerBar() method
- [x] apiService.js - getBarProfile() method
- [x] Fixed Content-Type header issue

**Frontend Status:** ✅ READY

---

## ✅ Backend Checklist

- [x] Field name validation (piva, barName, businessName, address)
- [x] Multipart form-data parsing
- [x] PNG file validation
- [x] Image optimization & storage
- [x] Database field mapping
- [x] Response field mapping
- [x] Static file serving
- [x] Error handling
- [x] GET /api/bar/profile endpoint
- [x] POST /api/bar/registration endpoint

**Backend Status:** ✅ READY

---

## 🧪 Quick Test

### Terminal 1 - Backend
```bash
cd back-end
npm run dev
# Wait for: ✨ Server pronto!
```

### Terminal 2 - Frontend
```bash
cd front-end
npm start
```

### Mobile/Simulator
1. Login
2. Click "Registra il tuo Bar"
3. Fill form + select PNG image
4. Click "Registra il Bar"
5. See BarSuccessScreen
6. Go to Home → See bar profile
7. Click on profile → See BarProfileScreen

---

## 🐛 Debug Logs to Check

### Backend
```
📁 File ricevuto: filename.png (image/png, XXXXX bytes)
✅ Immagine salvata: /uploads/bars/...
✅ Bar creato con ID: 123
✅ Bar registrato con successo: Bar Milano (ID: 123)
```

### Frontend
```
🏪 Inizio registrazione bar...
📤 Invio dati bar al backend...
✅ Bar registrato con successo: {...}
```

---

## 🔗 Key Code Locations

| Component | File | What |
|-----------|------|------|
| Registration Form | Front-end/src/pages/BarRegistrationScreen.js | Form UI |
| API Call | Front-end/src/services/apiService.js | registerBar() method |
| Success Screen | Front-end/src/pages/BarSuccessScreen.js | Confirmation |
| Profile Screen | Front-end/src/pages/BarProfileScreen.js | Details view |
| Home Section | Front-end/src/pages/HomeScreen.js | Register button |
| Backend Endpoint | Back-end/src/controllers/barController.ts | register() handler |
| Image Upload | Back-end/src/utils/imageUpload.ts | File handling |
| Validation | Back-end/src/validators/barValidator.ts | Zod schema |
| Repository | Back-end/src/repositories/barRepository.ts | DB queries |

---

## 📊 Data Flow Diagram

```
FRONTEND                          BACKEND                    DATABASE
─────────────────────────────────────────────────────────────────────

Fill Form + Select Image
        ↓
imageUpload.convertImageToPng()
        ↓
Create FormData
        ↓
POST /api/bar/registration ────→ authenticateToken middleware
                                    ↓
                                Parse multipart
                                    ↓
                                Validate (Zod)
                                    ↓
                                Check file (PNG, 5MB)
                                    ↓
                                saveAndOptimizeImage() ──→ /uploads/bars/
                                    ↓
                                barController.register()
                                    ↓
                                barRepository.createBar()
                                    ↓
                                INSERT bar ─────────────→ bars table
                                    ↓
                        Return mapped response
        ←──────────────── 200 OK + bar data
        ↓
Store in BarSuccessScreen
        ↓
User clicks "Home"
        ↓
HomeScreen calls getBarProfile()
        ↓
GET /api/bar/profile ──────────→ Query bars table
                                    ↓
                        Map fields to frontend names
        ←──────────────── 200 OK + bar data
        ↓
Display in HomeScreen/BarProfileScreen
```

---

## ⚠️ Common Issues & Fixes

| Issue | Cause | Fix |
|-------|-------|-----|
| 400 "Validation Error" | Bad P.IVA format | Must be exactly 11 digits |
| 409 "PIVA_EXISTS" | P.IVA already registered | Use different P.IVA |
| 409 "BAR_ALREADY_EXISTS" | User already has bar | One bar per user |
| 400 "INVALID_FILE_TYPE" | Non-PNG file selected | Select PNG file |
| 400 "FILE_TOO_LARGE" | File > 5MB | Select smaller image |
| 401 "Unauthorized" | Invalid token | Login first |
| Image not displaying | Image not saved | Check /uploads/bars/ directory |
| "@fastify/static" error | Module not installed | `npm install @fastify/static` |

---

## 🎯 Next Steps

After testing, the following features are ready for implementation:

1. **PUT /api/bar/{id}** - Edit bar profile
2. **DELETE /api/bar/{id}** - Delete bar
3. **GET /api/bar/{id}/stats** - Bar statistics
4. **GET /api/bar/{id}/clients** - List bar customers
5. Cloud storage integration (AWS S3, Firebase, Cloudinary)
6. Image compression for mobile optimization

---

## 📞 Support

For issues with:
- **Content-Type errors:** Check that FormData is used correctly
- **File upload failures:** Verify MIME type is image/png
- **Database errors:** Check PostgreSQL connection
- **CORS issues:** Allowed origins configured in index.ts
- **Missing fields in response:** Check field mapping in controllers

---

**Last Updated:** 2025-02-14  
**Status:** ✅ Production Ready
