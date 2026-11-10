
export interface GeographicCoordinate {
  latitudeDeg: number;
  longitudeEastDeg: number;
}

export interface ProjectedCoordinate {
  xMeters: number;
  yMeters: number;
}

export interface RasterPixelCoordinate {
  column: number;
  row: number;
}

export interface LolaTerrainMetadata {
  width: number;
  height: number;
  minElevation: number;
  maxElevation: number;
  resolutionMeters: number;
  bbox: [number, number, number, number];
  pixelResolution: [number, number, number];

  coordinateSystem: {
    projection: string;
    referenceFrame: string;
    ephemeris: string;
    linearUnits: string;
    pixelRegistration: string;
  };

  georeferencing: {
    tiePoint: {
      column: number;
      row: number;
      x: number;
      y: number;
    };
    centralMeridianDegrees: number;
    lunarRadiusMeters: number;
  };

  dataType: string;
  byteOrder: string;
}

export interface LolaTerrainData {
  width: number;
  height: number;
  minElevation: number;
  maxElevation: number;
  resolutionMeters: number;
  metadata: LolaTerrainMetadata;
  elevations: Float32Array;
}

export interface LolaSample {
  geographic: GeographicCoordinate;
  projected: ProjectedCoordinate;
  pixel: RasterPixelCoordinate;
  nearestPixel: {
    column: number;
    row: number;
  };
  elevationMeters: number;
}

const DATA_PATH = "/data/site04_shackleton_rim";

export const SITE04_COORDINATES: GeographicCoordinate = {
  latitudeDeg: -89.7668,
  longitudeEastDeg: 188.13,
};

let terrainPromise: Promise<LolaTerrainData> | null = null;

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite. Received: ${value}`);
  }
}

function requireObject(
  value: unknown,
  name: string
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is missing or invalid.`);
  }

  return value as Record<string, unknown>;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} is missing or invalid.`);
  }

  return value;
}

function validateMetadata(raw: unknown): LolaTerrainMetadata {
  const root = requireObject(raw, "Root metadata");

  const coordinateSystem = requireObject(
    root.coordinateSystem,
    "coordinateSystem"
  );

  const georeferencing = requireObject(
    root.georeferencing,
    "georeferencing"
  );

  const tiePoint = requireObject(
    georeferencing.tiePoint,
    "georeferencing.tiePoint"
  );

  const pixelResolution = root.pixelResolution;
  const bbox = root.bbox;

  if (!Array.isArray(pixelResolution) || pixelResolution.length < 2) {
    throw new Error("Invalid pixelResolution.");
  }

  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new Error("Invalid bounding box.");
  }

  const metadata: LolaTerrainMetadata = {
    width: requireNumber(root.width, "width"),
    height: requireNumber(root.height, "height"),
    minElevation: requireNumber(root.minElevation, "minElevation"),
    maxElevation: requireNumber(root.maxElevation, "maxElevation"),
    resolutionMeters: requireNumber(root.resolutionMeters, "resolutionMeters"),

    bbox: [
      requireNumber(bbox[0], "bbox[0]"),
      requireNumber(bbox[1], "bbox[1]"),
      requireNumber(bbox[2], "bbox[2]"),
      requireNumber(bbox[3], "bbox[3]"),
    ],

    pixelResolution: [
      requireNumber(pixelResolution[0], "pixelResolution[0]"),
      requireNumber(pixelResolution[1], "pixelResolution[1]"),
      requireNumber(pixelResolution[2] ?? 0, "pixelResolution[2]"),
    ],

    coordinateSystem: {
      projection: String(coordinateSystem.projection ?? ""),
      referenceFrame: String(coordinateSystem.referenceFrame ?? ""),
      ephemeris: String(coordinateSystem.ephemeris ?? ""),
      linearUnits: String(coordinateSystem.linearUnits ?? ""),
      pixelRegistration: String(coordinateSystem.pixelRegistration ?? ""),
    },

    georeferencing: {
      tiePoint: {
        column: requireNumber(tiePoint.column, "tiePoint.column"),
        row: requireNumber(tiePoint.row, "tiePoint.row"),
        x: requireNumber(tiePoint.x, "tiePoint.x"),
        y: requireNumber(tiePoint.y, "tiePoint.y"),
      },

      centralMeridianDegrees: requireNumber(
        georeferencing.centralMeridianDegrees,
        "centralMeridianDegrees"
      ),

      lunarRadiusMeters: requireNumber(
        georeferencing.lunarRadiusMeters,
        "lunarRadiusMeters"
      ),
    },

    dataType: String(root.dataType ?? ""),
    byteOrder: String(root.byteOrder ?? ""),
  };

  if (
    !Number.isInteger(metadata.width) ||
    metadata.width <= 0 ||
    !Number.isInteger(metadata.height) ||
    metadata.height <= 0
  ) {
    throw new Error("Invalid raster dimensions.");
  }

  if (metadata.coordinateSystem.projection !== "South Polar Stereographic") {
    throw new Error("Unsupported projection.");
  }

  if (metadata.coordinateSystem.linearUnits !== "meters") {
    throw new Error("Expected raster coordinates in metres.");
  }

  if (metadata.coordinateSystem.pixelRegistration !== "pixel area") {
    throw new Error(
      `Expected PixelIsArea registration. Received: ${metadata.coordinateSystem.pixelRegistration}`
    );
  }

  if (metadata.georeferencing.lunarRadiusMeters <= 0) {
    throw new Error("Invalid lunar radius.");
  }

  if (
    metadata.pixelResolution[0] === 0 ||
    metadata.pixelResolution[1] === 0
  ) {
    throw new Error("Invalid pixel resolution.");
  }

  if (metadata.dataType !== "Float32") {
    throw new Error("Expected Float32 elevation data.");
  }

  if (metadata.byteOrder !== "little-endian") {
    throw new Error("Expected little-endian elevation data.");
  }

  return metadata;
}

export async function loadLolaTerrain(): Promise<LolaTerrainData> {
  if (terrainPromise) return terrainPromise;

  terrainPromise = (async () => {
    console.info("[LOLA] Loading terrain...");

    const [metadataResponse, elevationResponse] = await Promise.all([
      fetch(`${DATA_PATH}/metadata.json`, { cache: "no-store" }),
      fetch(`${DATA_PATH}/elevation.bin`, { cache: "no-store" }),
    ]);

    if (!metadataResponse.ok) {
      throw new Error(`Metadata HTTP error: ${metadataResponse.status}`);
    }

    if (!elevationResponse.ok) {
      throw new Error(`Elevation HTTP error: ${elevationResponse.status}`);
    }

    const rawMetadata: unknown = await metadataResponse.json();
    const metadata = validateMetadata(rawMetadata);

    const buffer = await elevationResponse.arrayBuffer();

    const expectedPixels = metadata.width * metadata.height;
    const expectedBytes = expectedPixels * Float32Array.BYTES_PER_ELEMENT;

    if (buffer.byteLength !== expectedBytes) {
      throw new Error(
        `Expected ${expectedBytes} bytes, received ${buffer.byteLength}.`
      );
    }

    const elevations = new Float32Array(expectedPixels);
    const view = new DataView(buffer);

    let actualMin = Infinity;
    let actualMax = -Infinity;

    for (let i = 0; i < expectedPixels; i++) {
      const elevation = view.getFloat32(i * 4, true);

      if (!Number.isFinite(elevation)) {
        throw new Error(`Invalid elevation at binary index ${i}.`);
      }

      elevations[i] = elevation;
      actualMin = Math.min(actualMin, elevation);
      actualMax = Math.max(actualMax, elevation);
    }

    console.info("[LOLA] Terrain loaded:", {
      dimensions: `${metadata.width} x ${metadata.height}`,
      registration: metadata.coordinateSystem.pixelRegistration,
      actualMin,
      actualMax,
    });

    return {
      width: metadata.width,
      height: metadata.height,
      minElevation: metadata.minElevation,
      maxElevation: metadata.maxElevation,
      resolutionMeters: metadata.resolutionMeters,
      metadata,
      elevations,
    };
  })();

  try {
    return await terrainPromise;
  } catch (error) {
    terrainPromise = null;
    console.error("[LOLA] Loading failed:", error);
    throw error;
  }
}

/**
 * Geographic coordinates to South Polar Stereographic.
 */
export function geographicToLolaProjected(
  coordinate: GeographicCoordinate,
  metadata: LolaTerrainMetadata
): ProjectedCoordinate {
  const latitude = coordinate.latitudeDeg;
  const longitude = coordinate.longitudeEastDeg;

  assertFinite(latitude, "Latitude");
  assertFinite(longitude, "Longitude");

  if (latitude < -90 || latitude > 0) {
    throw new Error("Latitude must be between -90 and 0 degrees.");
  }

  const radius = metadata.georeferencing.lunarRadiusMeters;
  const centralMeridian =
    metadata.georeferencing.centralMeridianDegrees;

  const latitudeFromSouthPole =
    ((90 + latitude) * Math.PI) / 180;

  const longitudeDifference =
    ((longitude - centralMeridian) * Math.PI) / 180;

  const rho =
    2 * radius * Math.tan(latitudeFromSouthPole / 2);

  return {
    xMeters: rho * Math.sin(longitudeDifference),
    yMeters: rho * Math.cos(longitudeDifference),
  };
}

/**
 * Converts projected coordinates to array indices.
 *
 * GeoTIFF PixelIsArea means the tie point represents
 * the outer corner of the first pixel.
 * Array indices represent pixel centres.
 */
export function projectedToLolaPixel(
  projected: ProjectedCoordinate,
  metadata: LolaTerrainMetadata
): RasterPixelCoordinate {
  const tiePoint = metadata.georeferencing.tiePoint;
  const [pixelWidth, pixelHeight] = metadata.pixelResolution;

  assertFinite(projected.xMeters, "Projected X");
  assertFinite(projected.yMeters, "Projected Y");

  return {
    column:
      tiePoint.column +
      (projected.xMeters - tiePoint.x) / pixelWidth -
      0.5,

    row:
      tiePoint.row +
      (projected.yMeters - tiePoint.y) / pixelHeight -
      0.5,
  };
}

export function isLolaPixelInsideRaster(
  pixel: RasterPixelCoordinate,
  terrain: LolaTerrainData
): boolean {
  return (
    pixel.column >= 0 &&
    pixel.row >= 0 &&
    pixel.column <= terrain.width - 1 &&
    pixel.row <= terrain.height - 1
  );
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sampleLolaHeightAtPixel(
  terrain: LolaTerrainData,
  pixel: RasterPixelCoordinate
): number {
  assertFinite(pixel.column, "Pixel column");
  assertFinite(pixel.row, "Pixel row");

  if (!isLolaPixelInsideRaster(pixel, terrain)) {
    throw new Error(
      `Pixel outside raster: column=${pixel.column.toFixed(4)}, row=${pixel.row.toFixed(4)}`
    );
  }

  const x0 = Math.floor(pixel.column);
  const y0 = Math.floor(pixel.row);

  const x1 = Math.min(x0 + 1, terrain.width - 1);
  const y1 = Math.min(y0 + 1, terrain.height - 1);

  const tx = pixel.column - x0;
  const ty = pixel.row - y0;

  const topLeft = terrain.elevations[y0 * terrain.width + x0];
  const topRight = terrain.elevations[y0 * terrain.width + x1];
  const bottomLeft = terrain.elevations[y1 * terrain.width + x0];
  const bottomRight = terrain.elevations[y1 * terrain.width + x1];

  if (
    !Number.isFinite(topLeft) ||
    !Number.isFinite(topRight) ||
    !Number.isFinite(bottomLeft) ||
    !Number.isFinite(bottomRight)
  ) {
    throw new Error("Invalid elevation during interpolation.");
  }

  const top = lerp(topLeft, topRight, tx);
  const bottom = lerp(bottomLeft, bottomRight, tx);

  return lerp(top, bottom, ty);
}

export function sampleLolaHeightAtLocation(
  terrain: LolaTerrainData,
  coordinate: GeographicCoordinate
): LolaSample {
  const projected = geographicToLolaProjected(
    coordinate,
    terrain.metadata
  );

  const pixel = projectedToLolaPixel(
    projected,
    terrain.metadata
  );

  if (!isLolaPixelInsideRaster(pixel, terrain)) {
    throw new Error(
      `Location outside raster: column=${pixel.column.toFixed(4)}, row=${pixel.row.toFixed(4)}`
    );
  }

  const elevationMeters = sampleLolaHeightAtPixel(terrain, pixel);

  return {
    geographic: coordinate,
    projected,
    pixel,
    nearestPixel: {
      column: Math.round(pixel.column),
      row: Math.round(pixel.row),
    },
    elevationMeters,
  };
}

export function sampleSite04Elevation(
  terrain: LolaTerrainData
): LolaSample {
  return sampleLolaHeightAtLocation(terrain, SITE04_COORDINATES);
}
