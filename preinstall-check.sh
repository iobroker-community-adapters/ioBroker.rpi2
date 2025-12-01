#!/usr/bin/env bash

set -e

REQUIRED_VERSION="2.2"
PACKAGE_NAME="libgpiod-dev"

echo "Checking package: $PACKAGE_NAME >= $REQUIRED_VERSION"

if [ "$CI" = "true" ]; then
  echo "$PACKAGE_NAME package check skipped in CI env"
  exit 0
fi

INSTALLED_VERSION=$(dpkg -s "$PACKAGE_NAME" 2>/dev/null | grep '^Version:' | awk '{print $2}')

if [ -z "$INSTALLED_VERSION" ]; then
  echo "$PACKAGE_NAME is not installed"
  exit 1
fi

if dpkg --compare-versions "$INSTALLED_VERSION" ge "$REQUIRED_VERSION"; then
  echo "$PACKAGE_NAME version OK: $INSTALLED_VERSION"
else
  echo "$PACKAGE_NAME is too old: $INSTALLED_VERSION (required: >=$REQUIRED_VERSION)"
  exit 1
fi
