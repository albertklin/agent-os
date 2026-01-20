/**
 * Structured error types for container sandbox operations
 *
 * Provides clear, typed error handling for container operations with:
 * - Specific error codes for different failure modes
 * - Recoverable flag to indicate if retry is possible
 * - User-friendly messages for UI display
 */

export type ContainerErrorCode =
  | "DOCKER_UNAVAILABLE"
  | "CONTAINER_CREATE_FAILED"
  | "CONTAINER_UNHEALTHY"
  | "FIREWALL_INIT_FAILED"
  | "CONTAINER_NOT_FOUND"
  | "HEALTH_CHECK_FAILED"
  | "CONTAINER_STOPPED"
  | "MOUNT_MISMATCH";

const userMessages: Record<ContainerErrorCode, string> = {
  DOCKER_UNAVAILABLE:
    "Docker is not available. Please ensure Docker is running.",
  CONTAINER_CREATE_FAILED:
    "Failed to create sandbox container. Please try again.",
  CONTAINER_UNHEALTHY:
    "Sandbox container is unhealthy. Please recreate the session.",
  FIREWALL_INIT_FAILED:
    "Failed to initialize container firewall. Session cannot be used safely.",
  CONTAINER_NOT_FOUND:
    "Sandbox container not found. It may have been removed externally.",
  HEALTH_CHECK_FAILED:
    "Container health check failed. Please recreate the session.",
  CONTAINER_STOPPED:
    "Sandbox container has stopped. Please recreate the session.",
  MOUNT_MISMATCH:
    "Container mount configuration is incorrect. Please recreate the session.",
};

export class ContainerError extends Error {
  constructor(
    message: string,
    public readonly code: ContainerErrorCode,
    public readonly recoverable: boolean = false,
    public readonly userMessage: string = userMessages[code]
  ) {
    super(message);
    this.name = "ContainerError";
  }

  /**
   * Create a DOCKER_UNAVAILABLE error
   */
  static dockerUnavailable(): ContainerError {
    return new ContainerError(
      "Docker daemon is not available or not running",
      "DOCKER_UNAVAILABLE",
      true // Recoverable if Docker is started
    );
  }

  /**
   * Create a CONTAINER_CREATE_FAILED error
   */
  static createFailed(reason: string): ContainerError {
    return new ContainerError(
      `Failed to create container: ${reason}`,
      "CONTAINER_CREATE_FAILED",
      true // Can retry container creation
    );
  }

  /**
   * Create a CONTAINER_UNHEALTHY error
   */
  static unhealthy(reason: string): ContainerError {
    return new ContainerError(
      `Container is unhealthy: ${reason}`,
      "CONTAINER_UNHEALTHY",
      false // Need to recreate session
    );
  }

  /**
   * Create a FIREWALL_INIT_FAILED error
   */
  static firewallFailed(reason: string): ContainerError {
    return new ContainerError(
      `Firewall initialization failed: ${reason}`,
      "FIREWALL_INIT_FAILED",
      false // Security-critical, don't retry
    );
  }

  /**
   * Create a CONTAINER_NOT_FOUND error
   */
  static notFound(containerId: string): ContainerError {
    return new ContainerError(
      `Container ${containerId} not found`,
      "CONTAINER_NOT_FOUND",
      false // Need to recreate session
    );
  }

  /**
   * Create a HEALTH_CHECK_FAILED error
   */
  static healthCheckFailed(reason: string): ContainerError {
    return new ContainerError(
      `Health check failed: ${reason}`,
      "HEALTH_CHECK_FAILED",
      false // Need to recreate session
    );
  }

  /**
   * Create a CONTAINER_STOPPED error
   */
  static stopped(containerId: string): ContainerError {
    return new ContainerError(
      `Container ${containerId} has stopped`,
      "CONTAINER_STOPPED",
      false // Need to recreate session
    );
  }

  /**
   * Create a MOUNT_MISMATCH error
   */
  static mountMismatch(expected: string, actual: string): ContainerError {
    return new ContainerError(
      `Mount mismatch: expected ${expected}, got ${actual}`,
      "MOUNT_MISMATCH",
      false // Need to recreate session
    );
  }
}
