
import {
  type GeographicCoordinate,
  type LolaTerrainData,
  type ProjectedCoordinate,
  SITE04_COORDINATES,
  geographicToLolaProjected,
  projectedToLolaPixel,
  isLolaPixelInsideRaster,
  sampleLolaHeightAtPixel,
  sampleLolaHeightAtLocation,
} from "./terrainData";

export type TerrainHorizonTermination =
  | "raster_boundary"
  | "search_limit";

export interface TerrainHorizonDirection {
  azimuthDeg: number;
  horizonElevationDeg: number;
  distanceMeters: number;
  terrainElevationMeters: number;
  samplesChecked: number;

  // Why sampling stopped in this direction.
  terminationReason: TerrainHorizonTermination;

  // The profile is limited either by raster coverage or
  // by the configured maximum search distance.
  coverageLimited: true;
}

export interface TerrainHorizonResult {
  observer: GeographicCoordinate;
  observerProjected: ProjectedCoordinate;
  observerElevationMeters: number;
  lunarRadiusMeters: number;
  sampleStepMeters: number;
  maxDistanceMeters: number;

  directions: TerrainHorizonDirection[];
  calculatedDirections: number;
  totalSamplesChecked: number;

  rasterBoundaryLimitedDirections: number;
  searchLimitReachedDirections: number;

  // This is deliberately false: a finite raster and search
  // distance cannot establish the horizon beyond their coverage.
  completeHorizonVerified: false;
}

export interface TerrainHorizonOptions {
  directionCount?: number;
  sampleStepMeters?: number;
  maxDistanceMeters?: number;
}

const DEFAULT_DIRECTION_COUNT = 360;
const DEFAULT_SAMPLE_STEP_METERS = 5;
const DEFAULT_MAX_DISTANCE_METERS = 15000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/**
 * Calculates a destination coordinate on a spherical Moon.
 *
 * Bearing convention:
 * 0° = North
 * 90° = East
 * 180° = South
 * 270° = West
 */
function destinationCoordinate(
  start: GeographicCoordinate,
  bearingDeg: number,
  distanceMeters: number,
  lunarRadiusMeters: number
): GeographicCoordinate {
  const latitude1 = toRadians(start.latitudeDeg);
  const longitude1 = toRadians(start.longitudeEastDeg);
  const bearing = toRadians(bearingDeg);

  const angularDistance = distanceMeters / lunarRadiusMeters;

  const sinLatitude2 =
    Math.sin(latitude1) * Math.cos(angularDistance) +
    Math.cos(latitude1) *
      Math.sin(angularDistance) *
      Math.cos(bearing);

  const latitude2 = Math.asin(
    Math.max(-1, Math.min(1, sinLatitude2))
  );

  const longitude2 =
    longitude1 +
    Math.atan2(
      Math.sin(bearing) *
        Math.sin(angularDistance) *
        Math.cos(latitude1),
      Math.cos(angularDistance) -
        Math.sin(latitude1) * Math.sin(latitude2)
    );

  return {
    latitudeDeg: toDegrees(latitude2),
    longitudeEastDeg: toDegrees(longitude2),
  };
}

/**
 * Calculates apparent terrain elevation relative to the
 * observer's local horizontal plane.
 *
 * Lunar curvature is included.
 */
function calculateTerrainElevationAngle(
  observerElevationMeters: number,
  terrainElevationMeters: number,
  distanceMeters: number,
  lunarRadiusMeters: number
): number {
  if (distanceMeters <= 0) {
    return -90;
  }

  const observerRadius =
    lunarRadiusMeters + observerElevationMeters;

  const terrainRadius =
    lunarRadiusMeters + terrainElevationMeters;

  const angularDistance = distanceMeters / lunarRadiusMeters;

  const vertical =
    terrainRadius * Math.cos(angularDistance) -
    observerRadius;

  const horizontal =
    terrainRadius * Math.sin(angularDistance);

  return toDegrees(Math.atan2(vertical, horizontal));
}

/**
 * Calculates the terrain horizon along one azimuth.
 *
 * Sampling stops when either:
 * 1. The path leaves the available LOLA raster.
 * 2. The configured maximum search distance is reached.
 *
 * Neither condition proves that terrain beyond the sampled
 * area cannot produce a higher horizon.
 */
function calculateDirectionHorizon(
  terrain: LolaTerrainData,
  observer: GeographicCoordinate,
  observerElevationMeters: number,
  azimuthDeg: number,
  sampleStepMeters: number,
  maxDistanceMeters: number
): TerrainHorizonDirection {
  const lunarRadius =
    terrain.metadata.georeferencing.lunarRadiusMeters;

  let maximumAngle = -90;
  let maximumDistance = 0;
  let maximumTerrainElevation = observerElevationMeters;
  let samplesChecked = 0;

  let terminationReason: TerrainHorizonTermination =
    "search_limit";

  for (
    let distance = sampleStepMeters;
    distance <= maxDistanceMeters;
    distance += sampleStepMeters
  ) {
    const coordinate = destinationCoordinate(
      observer,
      azimuthDeg,
      distance,
      lunarRadius
    );

    const projected = geographicToLolaProjected(
      coordinate,
      terrain.metadata
    );

    const pixel = projectedToLolaPixel(
      projected,
      terrain.metadata
    );

    if (!isLolaPixelInsideRaster(pixel, terrain)) {
      terminationReason = "raster_boundary";
      break;
    }

    const terrainElevation = sampleLolaHeightAtPixel(
      terrain,
      pixel
    );

    const elevationAngle = calculateTerrainElevationAngle(
      observerElevationMeters,
      terrainElevation,
      distance,
      lunarRadius
    );

    samplesChecked++;

    if (elevationAngle > maximumAngle) {
      maximumAngle = elevationAngle;
      maximumDistance = distance;
      maximumTerrainElevation = terrainElevation;
    }
  }

  return {
    azimuthDeg,
    horizonElevationDeg: maximumAngle,
    distanceMeters: maximumDistance,
    terrainElevationMeters: maximumTerrainElevation,
    samplesChecked,
    terminationReason,
    coverageLimited: true,
  };
}

/**
 * Calculates a sampled terrain horizon around the observer.
 *
 * IMPORTANT:
 * This is a terrain horizon estimate within the available
 * LOLA raster and configured search distance. It is not
 * proof of the complete lunar horizon.
 */
export function calculateTerrainHorizon(
  terrain: LolaTerrainData,
  observer: GeographicCoordinate = SITE04_COORDINATES,
  options: TerrainHorizonOptions = {}
): TerrainHorizonResult {
  const directionCount =
    options.directionCount ?? DEFAULT_DIRECTION_COUNT;

  const sampleStepMeters =
    options.sampleStepMeters ?? DEFAULT_SAMPLE_STEP_METERS;

  const maxDistanceMeters =
    options.maxDistanceMeters ?? DEFAULT_MAX_DISTANCE_METERS;

  if (!Number.isInteger(directionCount) || directionCount < 4) {
    throw new Error(
      "directionCount must be an integer of at least 4."
    );
  }

  if (!Number.isFinite(sampleStepMeters) || sampleStepMeters <= 0) {
    throw new Error(
      "sampleStepMeters must be greater than zero."
    );
  }

  if (!Number.isFinite(maxDistanceMeters) || maxDistanceMeters <= 0) {
    throw new Error(
      "maxDistanceMeters must be greater than zero."
    );
  }

  if (
    !Number.isFinite(observer.latitudeDeg) ||
    observer.latitudeDeg < -90 ||
    observer.latitudeDeg > 90 ||
    !Number.isFinite(observer.longitudeEastDeg)
  ) {
    throw new Error("Invalid observer geographic coordinates.");
  }

  const observerSample = sampleLolaHeightAtLocation(
    terrain,
    observer
  );

  const lunarRadius =
    terrain.metadata.georeferencing.lunarRadiusMeters;

  const directions: TerrainHorizonDirection[] = [];

  let totalSamplesChecked = 0;
  let rasterBoundaryLimitedDirections = 0;
  let searchLimitReachedDirections = 0;

  for (let i = 0; i < directionCount; i++) {
    const azimuthDeg = (i * 360) / directionCount;

    const result = calculateDirectionHorizon(
      terrain,
      observer,
      observerSample.elevationMeters,
      azimuthDeg,
      sampleStepMeters,
      maxDistanceMeters
    );

    directions.push(result);

    totalSamplesChecked += result.samplesChecked;

    if (result.terminationReason === "raster_boundary") {
      rasterBoundaryLimitedDirections++;
    } else {
      searchLimitReachedDirections++;
    }
  }

  return {
    observer,
    observerProjected: observerSample.projected,
    observerElevationMeters: observerSample.elevationMeters,
    lunarRadiusMeters: lunarRadius,
    sampleStepMeters,
    maxDistanceMeters,

    directions,
    calculatedDirections: directions.length,
    totalSamplesChecked,

    rasterBoundaryLimitedDirections,
    searchLimitReachedDirections,

    completeHorizonVerified: false,
  };
}
