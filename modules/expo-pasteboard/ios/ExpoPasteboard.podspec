Pod::Spec.new do |s|
  s.name           = 'ExpoPasteboard'
  s.version        = '1.0.0'
  s.summary        = 'The file on the pasteboard, for Port22'
  s.description    = 'Reads an arbitrary copied file (a PDF, a zip) off UIPasteboard as bytes — the one thing expo-clipboard does not expose.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
