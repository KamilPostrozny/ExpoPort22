Pod::Spec.new do |s|
  s.name           = 'ExpoSSH'
  s.version        = '1.0.0'
  s.summary        = 'SSH client for Port22'
  s.description    = 'Citadel-backed SSH: host-key callback, ed25519 auth, PTY shell, exec channels, SFTP.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  # Citadel itself declares .iOS(.v17); the app target has to match (expo-build-properties in app.json).
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Citadel ships no podspec, so it comes in as a Swift package. `spm_dependency` is React Native's
  # helper (>= 0.75), not CocoaPods' — CocoaPods has no SPM support of its own.
  unless defined?(spm_dependency)
    raise 'ExpoSSH needs react-native >= 0.75 for its Swift Package Manager dependencies.'
  end

  # Xcode links declared products only, so Citadel's transitive packages are declared too: this
  # module imports NIOSSH (host-key delegate), Crypto (ed25519), NIOCore (ByteBuffer) and Logging
  # (the silent SFTP logger) directly. URLs and bounds mirror Citadel's own Package.swift pins —
  # a different URL for the same package is a separate identity and fails resolution.
  spm_dependency(s,
    url: 'https://github.com/orlandos-nl/Citadel.git',
    requirement: { kind: 'upToNextMinorVersion', minimumVersion: '0.12.1' },
    products: ['Citadel'])
  spm_dependency(s,
    url: 'https://github.com/Wellz26/swift-nio-ssh.git',
    requirement: { kind: 'upToNextMinorVersion', minimumVersion: '0.3.6' },
    products: ['NIOSSH'])
  spm_dependency(s,
    url: 'https://github.com/apple/swift-crypto.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '3.15.1' },
    products: ['Crypto'])
  spm_dependency(s,
    url: 'https://github.com/apple/swift-nio.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '2.101.3' },
    products: ['NIOCore'])
  spm_dependency(s,
    url: 'https://github.com/apple/swift-log.git',
    requirement: { kind: 'upToNextMajorVersion', minimumVersion: '1.14.0' },
    products: ['Logging'])

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
