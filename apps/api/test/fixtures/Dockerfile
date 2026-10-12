FROM nginx:alpine
RUN mkdir /www && printf 'healthy\n' > /www/healthz
COPY nginx.conf /etc/nginx/nginx.conf
USER 65534:65534
EXPOSE 3000
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
