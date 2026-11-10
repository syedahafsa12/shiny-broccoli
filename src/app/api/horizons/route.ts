
import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  type LolaTerrainData,
  sampleLolaHeightAtLocation,
} from "@/components/lib/lunar/terrainData";

import {
  calculateTerrainHorizon,
} from "@/components/lib/lunar/terrainHorizon";

const HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api";

const BASE_OBSERVER = {
  name: "Site04 — Shackleton Rim",
  longitudeEast: 188.13,
  latitude: -89.7668,
};

const STEP_SIZE = "10m";
const EXPECTED_OBSERVATIONS_PER_DAY = 145;

const TERRAIN_OPTIONS = {
  directionCount: 1440,
  sampleStepMeters: 5,
  maxDistanceMeters: 15000,
};

type HorizonsPayload = {
  result?: string;
  error?: string;
  signature?: {
    source?: string;
    version?: string;
  };
};

type Observation = {
  time: string;
  timeUtc: string;
  azimuthDeg: number;
  elevationDeg: number;
  horizonsMarker: string | null;
};

type ParsedObservations = {
  observations: Observation[];
  totalParsed: number;
  totalUnparsed: number;
  unparsedLines: string[];
};

type Observer = typeof BASE_OBSERVER & {
  altitudeKm: number;
};

type TerrainVisibility = {
  terrainHorizonElevationDeg: number;
  clearanceDeg: number;
  blockedBySampledTerrain: boolean;
  assessment:
  | "blocked_by_sampled_terrain"
  | "above_sampled_terrain_unconfirmed";
  terrainCoverageComplete: false;
};

type TerrainVisibilityObservation = Observation & {
  terrainVisibility: TerrainVisibility;
};

type VisibilityState =
  | "blocked_by_sampled_terrain"
  | "above_sampled_terrain_unconfirmed";

type VisibilityWindow = {
  state: VisibilityState;
  startTimeUtc: string;
  endTimeUtc: string;
  durationMinutes: number;
  observationCount: number;
  startClearanceDeg: number;
  endClearanceDeg: number;
};

let terrainPromise: Promise<LolaTerrainData> | null = null;

/**
 * Converts a JPL Horizons timestamp into a Unix timestamp.
 *
 * Horizons format:
 * 2026-Nov-09T00:00:00Z
 *
 * JavaScript Date.parse() does not reliably understand
 * abbreviated month names in ISO-like timestamps.
 */
function parseHorizonsUtc(timeUtc: string): number {
  const match = timeUtc.match(
    /^(\d{4})-([A-Za-z]{3})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/
  );

  if (!match) {
    throw new Error(
      `Invalid Horizons UTC timestamp: ${timeUtc}`
    );
  }

  const months: Record<string, number> = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };

  const [
    ,
    year,
    monthName,
    day,
    hour,
    minute,
    second,
    fraction = "",
  ] = match;

  const month = months[monthName];

  if (month === undefined) {
    throw new Error(
      `Invalid month in Horizons timestamp: ${timeUtc}`
    );
  }

  const milliseconds = Number(
    fraction.padEnd(3, "0").slice(0, 3) || "0"
  );

  return Date.UTC(
    Number(year),
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    milliseconds
  );
}

/**
 * Loads the NASA LOLA Site04 elevation raster.
 * The loaded terrain is cached in memory.
 */
async function loadTerrainFromDisk(): Promise<LolaTerrainData> {
  if (terrainPromise) {
    return terrainPromise;
  }

  const pending: Promise<LolaTerrainData> = (async () => {
    const directory = path.join(
      process.cwd(),
      "public",
      "data",
      "site04_shackleton_rim"
    );

    const [metadataText, binary] = await Promise.all([
      readFile(path.join(directory, "metadata.json"), "utf8"),
      readFile(path.join(directory, "elevation.bin")),
    ]);

    const metadata = JSON.parse(
      metadataText
    ) as LolaTerrainData["metadata"];

    const expectedBytes =
      metadata.width *
      metadata.height *
      Float32Array.BYTES_PER_ELEMENT;

    if (binary.byteLength !== expectedBytes) {
      throw new Error(
        `LOLA raster size mismatch. Expected ${expectedBytes} bytes, received ${binary.byteLength}.`
      );
    }

    // Copy Buffer data into an independent, aligned ArrayBuffer.
    const copiedBytes = Uint8Array.from(binary);

    // NASA raster values are little-endian Float32 values.
    const elevations = new Float32Array(copiedBytes.buffer);

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

  terrainPromise = pending;

  try {
    return await pending;
  } catch (error) {
    terrainPromise = null;
    throw error;
  }
}

/**
 * Parses the Horizons observer table into structured observations.
 */
function parseHorizonsTable(table: string): ParsedObservations {
  const observations: Observation[] = [];
  const unparsedLines: string[] = [];

  const lines = table
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const numberPattern =
    "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?";

  const rowRegex = new RegExp(
    `^(\\d{4}-[A-Za-z]{3}-\\d{2})\\s+` +
    `(\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?)\\s+` +
    `(\\*[A-Za-z]?)?\\s*` +
    `(${numberPattern})\\s+` +
    `(${numberPattern})\\s*$`
  );

  for (const line of lines) {
    if (!/^\d{4}-[A-Za-z]{3}-\d{2}\s+\d{2}:\d{2}/.test(line)) {
      continue;
    }

    const match = line.match(rowRegex);

    if (!match) {
      unparsedLines.push(line);
      continue;
    }

    const [, date, time, marker, azimuthValue, elevationValue] =
      match;

    const azimuthDeg = Number(azimuthValue);
    const elevationDeg = Number(elevationValue);

    if (
      !Number.isFinite(azimuthDeg) ||
      !Number.isFinite(elevationDeg) ||
      azimuthDeg < 0 ||
      azimuthDeg > 360 ||
      elevationDeg < -90 ||
      elevationDeg > 90
    ) {
      unparsedLines.push(line);
      continue;
    }

    const normalizedTime =
      time.length === 5 ? `${time}:00` : time;

    observations.push({
      time: `${date} ${time}`,
      timeUtc: `${date}T${normalizedTime}Z`,
      azimuthDeg,
      elevationDeg,
      horizonsMarker: marker || null,
    });
  }

  if (observations.length === 0) {
    throw new Error(
      "Could not parse any Horizons observations. Check the raw Horizons table format."
    );
  }

  return {
    observations,
    totalParsed: observations.length,
    totalUnparsed: unparsedLines.length,
    unparsedLines,
  };
}

/**
 * Requests one celestial target from JPL Horizons.
 */
async function getTargetEphemeris(
  targetId: "10" | "399",
  startTime: string,
  stopTime: string,
  observer: Observer
) {
  const params = new URLSearchParams({
    format: "json",
    COMMAND: `'${targetId}'`,
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'OBSERVER'",
    OBJ_DATA: "'NO'",
    CENTER: "'coord@301'",
    COORD_TYPE: "'GEODETIC'",
    SITE_COORD: `'${observer.longitudeEast},${observer.latitude},${observer.altitudeKm}'`,
    START_TIME: `'${startTime}'`,
    STOP_TIME: `'${stopTime}'`,
    STEP_SIZE: `'${STEP_SIZE}'`,
    QUANTITIES: "'4'",
    TIME_TYPE: "'UT'",
  });

  const response = await fetch(
    `${HORIZONS_URL}?${params.toString()}`,
    {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(60000),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Horizons HTTP error for target ${targetId}: ${response.status}`
    );
  }

  const payload = (await response.json()) as HorizonsPayload;

  if (payload.error) {
    throw new Error(
      `Horizons error for target ${targetId}: ${payload.error}`
    );
  }

  if (!payload.result) {
    throw new Error(
      `Horizons returned no result for target ${targetId}.`
    );
  }

  const tableMatch = payload.result.match(
    /\$\$SOE([\s\S]*?)\$\$EOE/
  );

  if (!tableMatch) {
    throw new Error(
      `Horizons observation table is missing for target ${targetId}.`
    );
  }

  const table = tableMatch[1].trim();
  const parsed = parseHorizonsTable(table);

  const isComplete =
    parsed.totalUnparsed === 0 &&
    parsed.totalParsed === EXPECTED_OBSERVATIONS_PER_DAY;

  return {
    targetId,
    observations: parsed.observations,
    parsing: {
      totalParsed: parsed.totalParsed,
      expectedObservations: EXPECTED_OBSERVATIONS_PER_DAY,
      totalUnparsed: parsed.totalUnparsed,
      missingObservations: Math.max(
        0,
        EXPECTED_OBSERVATIONS_PER_DAY - parsed.totalParsed
      ),
      unexpectedExtraObservations: Math.max(
        0,
        parsed.totalParsed - EXPECTED_OBSERVATIONS_PER_DAY
      ),
      isComplete,
      unparsedLines: parsed.unparsedLines,
    },
    raw: {
      table,
      result: payload.result,
      signature: payload.signature ?? null,
    },
  };
}

/**
 * Interpolates the terrain horizon at an arbitrary azimuth.
 * Handles the wrap from 359.75 degrees back to 0 degrees.
 */
function getTerrainHorizonAtAzimuth(
  azimuthDeg: number,
  profile: ReturnType<typeof calculateTerrainHorizon>["directions"]
) {
  const normalizedAzimuth =
    ((azimuthDeg % 360) + 360) % 360;

  const angularStep = 360 / profile.length;
  const position = normalizedAzimuth / angularStep;

  const lowerIndex = Math.floor(position) % profile.length;
  const upperIndex = (lowerIndex + 1) % profile.length;

  const fraction = position - Math.floor(position);

  const lower = profile[lowerIndex];
  const upper = profile[upperIndex];

  const horizonElevationDeg =
    lower.horizonElevationDeg +
    (upper.horizonElevationDeg -
      lower.horizonElevationDeg) *
    fraction;

  return {
    horizonElevationDeg,
    lowerAzimuthDeg: lower.azimuthDeg,
    upperAzimuthDeg: upper.azimuthDeg,
    lowerTerminationReason: lower.terminationReason,
    upperTerminationReason: upper.terminationReason,
  };
}

/**
 * Adds a terrain-obstruction assessment to every observation.
 *
 * Positive clearance is not proof of visibility because the
 * available raster does not cover the complete lunar horizon.
 */
function addTerrainVisibility(
  target: Awaited<ReturnType<typeof getTargetEphemeris>>,
  profile: ReturnType<typeof calculateTerrainHorizon>["directions"]
) {
  return {
    ...target,

    observations: target.observations.map((observation) => {
      const terrain = getTerrainHorizonAtAzimuth(
        observation.azimuthDeg,
        profile
      );

      const clearanceDeg =
        observation.elevationDeg -
        terrain.horizonElevationDeg;

      const blockedBySampledTerrain =
        clearanceDeg <= 0;

      return {
        ...observation,

        terrainVisibility: {
          terrainHorizonElevationDeg:
            terrain.horizonElevationDeg,

          clearanceDeg,

          blockedBySampledTerrain,

          assessment: blockedBySampledTerrain
            ? "blocked_by_sampled_terrain" as const
            : "above_sampled_terrain_unconfirmed" as const,

          terrainCoverageComplete: false as const,
        },
      };
    }),
  };
}

/**
 * Calculates continuous sampled intervals of terrain visibility.
 *
 * The window boundaries are observation timestamps.
 * They are not exact interpolated event times.
 */
function calculateVisibilityWindows(
  observations: TerrainVisibilityObservation[]
): VisibilityWindow[] {
  if (observations.length === 0) {
    return [];
  }

  // Sort by actual UTC time to ensure chronological windows.
  const sortedObservations = [...observations].sort(
    (a, b) =>
      parseHorizonsUtc(a.timeUtc) -
      parseHorizonsUtc(b.timeUtc)
  );

  const windows: VisibilityWindow[] = [];

  let currentState: VisibilityState | null = null;
  let windowStartIndex = 0;

  function getState(
    observation: TerrainVisibilityObservation
  ): VisibilityState {
    return observation.terrainVisibility.blockedBySampledTerrain
      ? "blocked_by_sampled_terrain"
      : "above_sampled_terrain_unconfirmed";
  }

  function closeWindow(endIndex: number) {
    if (currentState === null) {
      return;
    }

    const startObservation =
      sortedObservations[windowStartIndex];

    const endObservation =
      sortedObservations[endIndex];

    // FIX: Explicitly parse Horizons' non-standard month format.
    const startTime = parseHorizonsUtc(
      startObservation.timeUtc
    );

    const endTime = parseHorizonsUtc(
      endObservation.timeUtc
    );

    const durationMinutes =
      (endTime - startTime) / 60000;

    windows.push({
      state: currentState,

      startTimeUtc: startObservation.timeUtc,
      endTimeUtc: endObservation.timeUtc,

      durationMinutes: Math.max(0, durationMinutes),

      observationCount:
        endIndex - windowStartIndex + 1,

      startClearanceDeg:
        startObservation.terrainVisibility.clearanceDeg,

      endClearanceDeg:
        endObservation.terrainVisibility.clearanceDeg,
    });
  }

  for (
    let index = 0;
    index < sortedObservations.length;
    index++
  ) {
    const observation = sortedObservations[index];
    const state = getState(observation);

    if (currentState === null) {
      currentState = state;
      windowStartIndex = index;
      continue;
    }

    if (state !== currentState) {
      closeWindow(index - 1);

      currentState = state;
      windowStartIndex = index;
    }
  }

  closeWindow(sortedObservations.length - 1);

  return windows;
}

/**
 * Validates and builds a one-day UTC date range.
 */
function getDateRange(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Invalid date. Use YYYY-MM-DD.");
  }

  const start = new Date(`${date}T00:00:00.000Z`);

  if (
    Number.isNaN(start.getTime()) ||
    start.toISOString().slice(0, 10) !== date
  ) {
    throw new Error("Invalid calendar date.");
  }

  const stop = new Date(start);
  stop.setUTCDate(stop.getUTCDate() + 1);

  return {
    startTime: `${date} 00:00`,
    stopTime: `${stop.toISOString().slice(0, 10)} 00:00`,
  };
}

/**
 * Main API endpoint.
 */
export async function GET(request: NextRequest) {
  try {
    const requestedDate =
      request.nextUrl.searchParams.get("date") ??
      new Date().toISOString().slice(0, 10);

    const { startTime, stopTime } =
      getDateRange(requestedDate);

    // 1. Load actual NASA LOLA terrain.
    const terrain = await loadTerrainFromDisk();

    // 2. Get observer elevation from the actual LOLA raster.
    const observerSample = sampleLolaHeightAtLocation(
      terrain,
      {
        latitudeDeg: BASE_OBSERVER.latitude,
        longitudeEastDeg: BASE_OBSERVER.longitudeEast,
      }
    );

    const observer: Observer = {
      ...BASE_OBSERVER,
      altitudeKm: observerSample.elevationMeters / 1000,
    };

    // 3. Calculate the terrain horizon around the observer.
    const terrainHorizon = calculateTerrainHorizon(
      terrain,
      {
        latitudeDeg: observer.latitude,
        longitudeEastDeg: observer.longitudeEast,
      },
      TERRAIN_OPTIONS
    );

    // 4. Get real Sun and Earth positions from JPL Horizons.
    const [sun, earth] = await Promise.all([
      getTargetEphemeris(
        "10",
        startTime,
        stopTime,
        observer
      ),
      getTargetEphemeris(
        "399",
        startTime,
        stopTime,
        observer
      ),
    ]);

    // 5. Compare celestial positions against LOLA terrain.
    const sunWithTerrain = addTerrainVisibility(
      sun,
      terrainHorizon.directions
    );

    const earthWithTerrain = addTerrainVisibility(
      earth,
      terrainHorizon.directions
    );

    // 6. Calculate sampled visibility intervals.
    const sunVisibilityWindows =
      calculateVisibilityWindows(
        sunWithTerrain.observations
      );

    const earthVisibilityWindows =
      calculateVisibilityWindows(
        earthWithTerrain.observations
      );

    return NextResponse.json({
      success: true,

      source: [
        "NASA/JPL Horizons",
        "NASA LOLA Product 78 — Site04",
      ],

      observer: {
        ...observer,
        elevationSource: "NASA LOLA Site04 elevation raster",
        elevationMeters: observerSample.elevationMeters,
      },

      coordinateConvention: {
        longitude: "East-positive degrees",
        latitude:
          "Planetocentric/geodetic degrees as accepted by Horizons",
        altitude: "Kilometres",
      },

      timeRange: {
        start: startTime,
        stop: stopTime,
        timeScale: "UT",
        interval: "10 minutes",
        expectedObservationsPerTarget:
          EXPECTED_OBSERVATIONS_PER_DAY,
      },

      quantities: {
        code: "4",
        description: "Azimuth and elevation",
        angleUnit: "Degrees",
      },

      targets: {
        sun: {
          ...sunWithTerrain,
          visibilityWindows: sunVisibilityWindows,
        },

        earth: {
          ...earthWithTerrain,
          visibilityWindows: earthVisibilityWindows,
        },
      },

      terrainModel: {
        source: "NASA LOLA Product 78 — Site04",

        referenceFrame:
          terrain.metadata.coordinateSystem.referenceFrame,

        ephemeris:
          terrain.metadata.coordinateSystem.ephemeris,

        observerElevationMeters:
          observerSample.elevationMeters,

        sampleStepMeters:
          terrainHorizon.sampleStepMeters,

        directionCount:
          terrainHorizon.calculatedDirections,

        totalSamplesChecked:
          terrainHorizon.totalSamplesChecked,

        rasterBoundaryLimitedDirections:
          terrainHorizon.rasterBoundaryLimitedDirections,

        searchLimitReachedDirections:
          terrainHorizon.searchLimitReachedDirections,

        completeHorizonVerified:
          terrainHorizon.completeHorizonVerified,

        horizonProfile:
          terrainHorizon.directions.map((direction) => ({
            azimuthDeg: direction.azimuthDeg,
            horizonElevationDeg:
              direction.horizonElevationDeg,
            distanceMeters: direction.distanceMeters,
            terrainElevationMeters:
              direction.terrainElevationMeters,
            samplesChecked: direction.samplesChecked,
            terminationReason:
              direction.terminationReason,
          })),
      },

      interpretation: {
        azimuth: "Degrees clockwise from North.",

        elevation:
          "Degrees above or below the local astronomical horizon.",

        blockedBySampledTerrain:
          "The celestial object's elevation is at or below the interpolated terrain obstruction angle.",

        aboveSampledTerrainUnconfirmed:
          "The object is above sampled terrain at its azimuth, but complete visibility cannot be confirmed because the LOLA raster has limited coverage.",

        visibilityWindows:
          "Continuous intervals of sampled terrain-obstruction states. Window boundaries are observation timestamps, not exact interpolated event times.",

        completeVisibility:
          "Not established by this calculation. The terrain raster does not cover the complete lunar horizon.",

        horizonsMarker:
          "Preserved from the original Horizons table. It is not interpreted as terrain-adjusted visibility.",
      },

      notes: [
        "Sun and Earth observations are retrieved directly from NASA/JPL Horizons.",
        "Both targets are sampled every 10 minutes over a 24-hour UTC period.",
        "Each target is expected to return 145 observations, including both endpoints.",
        "Parsing completeness requires exactly 145 parsed observations and zero unparsed observation lines.",
        "Terrain elevations are sampled from the local NASA LOLA Site04 raster.",
        "Observer altitude is derived from the LOLA elevation at the observation point.",
        "Terrain horizon is sampled at 1440 azimuth directions with 5 metre distance steps.",
        "Terrain obstruction is evaluated independently for every Sun and Earth observation.",
        "Visibility windows group adjacent observations with the same terrain assessment.",
        "Visibility-window durations are calculated using explicitly parsed UTC timestamps.",
        "Window boundaries are sampled observation times, not interpolated crossing times.",
        "The available raster boundary limits every direction.",
        "Being above sampled terrain does not establish unobstructed visibility.",
        "These results do not yet calculate solar panel power or radio link performance.",
      ],
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown server error";

    console.error(
      "JPL Horizons terrain integration failed:",
      message
    );

    return NextResponse.json(
      {
        success: false,
        source: "NASA/JPL Horizons + NASA LOLA",
        error: message,
      },
      { status: 502 }
    );
  }
}
