$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compilerPath = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) { throw 'Existing Windows .NET Framework C# compiler not found. No installation was attempted.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$temporaryPath = Join-Path $projectRoot 'verification\runtime-temp'
[void][System.IO.Directory]::CreateDirectory($temporaryPath)
$savedTemp = $env:TEMP; $savedTmp = $env:TMP
try {
  $env:TEMP = $temporaryPath; $env:TMP = $temporaryPath
  & $compilerPath /nologo /optimize+ /target:exe /platform:x64 ('/out:' + (Join-Path $projectRoot 'bin\claude-wrapper.exe')) (Join-Path $projectRoot 'native\ClaudeWrapperLauncher.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Wrapper compilation failed.' }
  $pathContents = $nodePath + "`n" + (Join-Path $projectRoot 'src\claude-process-wrapper.mjs') + "`n"
  [System.IO.File]::WriteAllText((Join-Path $projectRoot 'bin\claude-wrapper.paths'), $pathContents, [System.Text.UTF8Encoding]::new($false))
} finally { $env:TEMP = $savedTemp; $env:TMP = $savedTmp }
Get-Item -LiteralPath (Join-Path $projectRoot 'bin\claude-wrapper.exe') | Select-Object FullName,Length
