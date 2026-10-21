param(
    [string]$ApiVersion = "2024.12"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$build = Join-Path $root ".build"
$classes = Join-Path $build "classes"
$apiJar = Join-Path $build "montoya-api-$ApiVersion.jar"
$dist = Join-Path $root "dist"
$outJar = Join-Path $dist "containers-burp-highlighter.jar"

$javac = (Get-Command javac -ErrorAction Stop).Source
$jarTool = Join-Path (Split-Path -Parent $javac) "jar.exe"
New-Item -ItemType Directory -Force -Path $build, $classes, $dist | Out-Null
if (Test-Path $classes) { Get-ChildItem $classes -Force | Remove-Item -Recurse -Force }

if (-not (Test-Path $apiJar)) {
    $url = "https://repo1.maven.org/maven2/net/portswigger/burp/extensions/montoya-api/$ApiVersion/montoya-api-$ApiVersion.jar"
    Write-Host "[*] Downloading Montoya API $ApiVersion"
    Invoke-WebRequest -Uri $url -OutFile $apiJar
}

$sources = Get-ChildItem (Join-Path $root "src\main\java") -Recurse -Filter *.java | Select-Object -ExpandProperty FullName
Write-Host "[*] Compiling $($sources.Count) source file(s)"
& $javac --release 17 -cp $apiJar -d $classes $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed with exit code $LASTEXITCODE" }

Copy-Item (Join-Path $root "src\main\resources\*") $classes -Recurse -Force
if (Test-Path $outJar) { Remove-Item $outJar -Force }
& $jarTool --create --file $outJar -C $classes .
if ($LASTEXITCODE -ne 0) { throw "jar failed with exit code $LASTEXITCODE" }

Write-Host "[+] Built $outJar"
Get-Item $outJar | Select-Object FullName, Length
