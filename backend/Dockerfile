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

ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Development

EXPOSE 8080

ENTRYPOINT ["dotnet", "Vectorify.Api.dll"]
