# The mock filler gateway as an image, built from the package, never from src/.
#
# From this tree (CI): `npm pack` @cancore/contracts and @cancore/test-kit into
# this directory, then `docker build -t cancore-mock-gateway packages/test-kit`.
# From npm: `docker build --build-arg SOURCE=registry packages/test-kit`.
#
# TEST ONLY: the keys inside are public. Never expose it beyond a CI network.
FROM node:22-alpine
ARG SOURCE=local
ARG VERSION=next
WORKDIR /opt/mock
# .dockerignore lets only the tarballs through (none when SOURCE=registry).
COPY . ./
RUN npm init -y >/dev/null \
 && if [ "$SOURCE" = registry ]; then npm install --no-audit --no-fund "@cancore/test-kit@$VERSION"; \
    else npm install --no-audit --no-fund ./cancore-contracts-*.tgz ./cancore-test-kit-*.tgz; fi \
 && rm -f ./*.tgz && npm cache clean --force
ENV PATH=/opt/mock/node_modules/.bin:$PATH
USER node
EXPOSE 8787 8788
ENTRYPOINT ["cancore-test-kit", "mock-gateway", "--host", "0.0.0.0"]
CMD ["--port", "8787", "--control", "8788"]
