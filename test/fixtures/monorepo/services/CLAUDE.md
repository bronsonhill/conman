# Services tier

Every service ships its own Dockerfile and healthcheck.
This file is listed in settings.claudeMdExcludes, so conman must not load it
for the services/api entry point.
