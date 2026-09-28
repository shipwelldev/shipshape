# Install Ship Shape on Windows:
#
#   powershell -ExecutionPolicy ByPass -c "irm https://shipshape.shipwell.dev/install.ps1 | iex"
#
# Environment:
#   SHIPSHAPE_VERSION         version to install, e.g. 0.1.0 (default: latest release)
#   SHIPSHAPE_INSTALL_DIR     where to put shipshape.exe (default: %LOCALAPPDATA%\Programs\shipshape)
#   SHIPSHAPE_NO_MODIFY_PATH  set to 1 to leave the user PATH alone
#   SHIPSHAPE_RELEASES_URL    release location (default: GitHub releases)
#
# Everything runs inside Install-Shipshape, called on the last line, so a partially
# downloaded script does nothing.

function Install-Shipshape {
    $ErrorActionPreference = 'Stop'
    # Windows PowerShell's progress bar slows Invoke-WebRequest downloads drastically.
    $ProgressPreference = 'SilentlyContinue'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Ship Shape requires 64-bit Windows.' }
    # The x64 build also runs on Windows on Arm through emulation.
    $asset = 'shipshape-windows-x64.zip'
    $releases = if ($env:SHIPSHAPE_RELEASES_URL) { $env:SHIPSHAPE_RELEASES_URL.TrimEnd('/') } else { 'https://github.com/shipwelldev/shipshape/releases' }
    $want = if ($env:SHIPSHAPE_VERSION) { $env:SHIPSHAPE_VERSION.TrimStart('v') } else { '' }
    $base = if ($want) { "$releases/download/v$want" } else { "$releases/latest/download" }
    $dir = if ($env:SHIPSHAPE_INSTALL_DIR) { $env:SHIPSHAPE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\shipshape' }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('shipshape-' + [Guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        $zip = Join-Path $tmp $asset
        $sums = Join-Path $tmp 'SHA256SUMS'
        Write-Host "shipshape: Downloading $asset$(if ($want) { " ($want)" })"
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $zip
        Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums

        $expected = $null
        foreach ($line in Get-Content $sums) {
            if ($line -match '^([0-9a-fA-F]{64})\s+\*?(.+)$' -and $Matches[2].Trim() -eq $asset) { $expected = $Matches[1].ToLower() }
        }
        if (-not $expected) { throw "SHA256SUMS has no entry for $asset." }
        $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
        if ($actual -ne $expected) { throw "Checksum mismatch for $asset; nothing was installed." }

        $extracted = Join-Path $tmp 'extracted'
        Expand-Archive -Path $zip -DestinationPath $extracted
        $new = Join-Path $extracted 'shipshape.exe'
        if (-not (Test-Path $new)) { throw "$asset does not contain shipshape.exe." }
        # A native program's failure is not a PowerShell error, so check its exit code and output
        # before anything already installed is touched.
        $version = (& $new --version | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw "The downloaded binary does not run on this system (exit code $LASTEXITCODE); nothing was installed." }
        if ($version -notmatch '^\d+\.\d+\.\d+') { throw 'The downloaded binary did not report a version; nothing was installed.' }
        if ($want -and $version -ne $want) { throw "The downloaded binary reports $version, expected $want." }

        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        $exe = Join-Path $dir 'shipshape.exe'
        # Copy the new binary next to the old one first, so the swap below is two renames within one
        # folder. A failed copy leaves the existing install untouched.
        $staged = "$exe.new"
        Copy-Item -Force $new $staged
        # A running shipshape.exe cannot be overwritten, but it can be renamed out of the way.
        Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
        $hadOld = Test-Path $exe
        if ($hadOld) { Move-Item -Force $exe "$exe.old" }
        try {
            Move-Item -Force $staged $exe
        }
        catch {
            if ($hadOld) { Move-Item -Force "$exe.old" $exe }
            Remove-Item -Force $staged -ErrorAction SilentlyContinue
            throw
        }
        Copy-Item -Force (Join-Path $extracted 'LICENSE') (Join-Path $dir 'LICENSE')
        Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
        Write-Host "shipshape: Installed shipshape $version to $exe"

        Add-ToUserPath $dir
    }
    finally {
        Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
}

function Add-ToUserPath([string] $dir) {
    $key = Get-Item -Path 'HKCU:\Environment'
    # Read the raw value so entries like %USERPROFILE%\bin stay unexpanded when written back.
    $raw = [string] $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $entries = @($raw -split ';' | Where-Object { $_ })
    $expanded = @($entries | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
    if ($expanded -contains $dir.TrimEnd('\')) { return }
    if ($env:SHIPSHAPE_NO_MODIFY_PATH -eq '1') {
        Write-Host "shipshape: Add $dir to your PATH to run shipshape."
        return
    }
    Set-ItemProperty -Path 'HKCU:\Environment' -Name 'Path' -Value (($entries + $dir) -join ';') -Type ExpandString
    # Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, so new terminals see the new PATH.
    [Environment]::SetEnvironmentVariable('SHIPSHAPE_INSTALLER', '1', 'User')
    [Environment]::SetEnvironmentVariable('SHIPSHAPE_INSTALLER', $null, 'User')
    $env:Path = "$env:Path;$dir"
    Write-Host "shipshape: Added $dir to your user PATH. Open a new terminal to run shipshape."
}

Install-Shipshape
