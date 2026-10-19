# Backend/orquestador — ASP.NET Core Web API.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY Vectorify.sln ./
COPY Vectorify.Api/Vectorify.Api.csproj Vectorify.Api/
COPY Vectorify.Api.Tests/Vectorify.Api.Tests.csproj Vectorify.Api.Tests/
RUN dotnet restore Vectorify.Api/Vectorify.Api.csproj

COPY Vectorify.Api/ Vectorify.Api/
RUN dotnet publish Vectorify.Api/Vectorify.Api.csproj -c Release -o /app/publish --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .

# Defaults SEGUROS de la imagen (M3.1-S09): Production + Authenticated. Antes (M3.1-S02) la imagen fijaba Development + Auth__Mode=Development
# (sin login, usuario fijo), así que cualquier despliegue sin overrides arrancaba abierto. Ahora una imagen sin overrides arranca en Production y
# EXIGE la configuración de producción (Auth__DataProtection__KeysPath en un volumen, cookie Secure, etc.; si falta algo, NO arranca).
# El modo de desarrollo (sin login) se pide de forma EXPLÍCITA en docker-compose.yml (ASPNETCORE_ENVIRONMENT=Development + Auth__Mode=Development);
# Auth__Mode=Development en cualquier entorno que no sea Development/Testing/Test impide el arranque.
# Sin secretos en la imagen: Postgres__ConnectionString y demás llegan por variables de entorno en tiempo de ejecución.
ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    Auth__Mode=Authenticated

EXPOSE 8080

ENTRYPOINT ["dotnet", "Vectorify.Api.dll"]
