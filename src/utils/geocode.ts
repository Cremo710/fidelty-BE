import { barRepository } from "../repositories/barRepository.js";

interface GoogleGeocodeResponse {
  status: string;
  results: Array<{ geometry: { location: { lat: number; lng: number } } }>;
}

export async function geocodeAddress(address: string): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const apiKey = process.env.GOOGLE_GEOCODE_API_KEY;
    if (!apiKey || !address) return null;

    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${apiKey}`;
    const response = await fetch(url);
    const json = (await response.json()) as GoogleGeocodeResponse;
    const location = json.status === "OK" ? json.results?.[0]?.geometry?.location : null;
    if (!location) return null;

    return { latitude: Number(location.lat), longitude: Number(location.lng) };
  } catch (error) {
    console.warn("⚠️ Geocoding fallito:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Una tantum: geocodifica e salva le coordinate dei bar che ne sono privi. */
export async function backfillBarCoordinates(): Promise<number> {
  const bars = await barRepository.findBarsMissingCoordinates();
  let updated = 0;

  for (const bar of bars) {
    const coords = await geocodeAddress(bar.address);
    if (!coords) continue;
    await barRepository.setCoordinates(bar.id, coords.latitude, coords.longitude);
    updated += 1;
  }

  return updated;
}
