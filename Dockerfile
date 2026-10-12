FROM node:22-alpine AS build
WORKDIR /workspace
COPY apps/dashboard/package*.json ./
RUN npm ci
COPY apps/dashboard/index.html apps/dashboard/tsconfig*.json apps/dashboard/vite.config.ts ./
COPY apps/dashboard/src/ ./src/
ARG VITE_API_BASE_URL=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine AS preview
COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY infra/nginx/preview.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/dist /usr/share/nginx/html
USER nginx
EXPOSE 80
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]

FROM preview AS dashboard
COPY infra/nginx/dashboard.conf /etc/nginx/conf.d/default.conf
