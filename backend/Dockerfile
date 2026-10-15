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

# Auth__Mode (M3.1-S02): la imagen de desarrollo sigue sirviendo la API con el usuario de desarrollo (sin login) hasta
# S03/S05. Un despliegue real sobreescribe AMBAS variables (ASPNETCORE_ENVIRONMENT=Production, Auth__Mode=Authenticated,
# Auth__Cookie__*): Auth__Mode=Development en cualquier entorno que no sea Development/Testing/Test impide el arranque.
# Sin secretos en la imagen: Postgres__ConnectionString y demás llegan por variables de entorno en tiempo de ejecución.
ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Development \
    Auth__Mode=Development

EXPOSE 8080

ENTRYPOINT ["dotnet", "Vectorify.Api.dll"]
