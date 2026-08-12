Pod::Spec.new do |s|
  s.name           = 'ExpoKeyInput'
  s.version        = '1.0.0'
  s.summary        = 'The key bar\'s keyboard owner'
  s.description    = 'A hidden UITextField that reports keys as keys and the hold-space trackpad as a drag translation.'
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
